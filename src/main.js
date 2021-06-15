const Apify = require('apify');
const _ = require('lodash');
const {
    initProxyConfig,
    initCrawler
} = require("./init");
const {LABELS, USER_AGENT} = require('./constants');
const {
    createQueryZpid,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    quickHash,
} = require('./functions');

const {log, puppeteer, sleep} = Apify.utils;

Apify.main(async () => {
    // This should be actually the other way around - something like `if config.DEBUG then Apify.utils.log.setLevel...`
    const isDebug = Apify.utils.log.getLevel() === Apify.utils.log.LEVELS.DEBUG;

    const input = await Apify.getInput() || {
        type: 'sold',
        startUrls: ['https://www.zillow.com/homedetails/1801-Tyler-Ter-Prague-OK-74864/2082985658_zpid/'],
    };

    const proxyConfig = await initProxyConfig(input)

    let {
        // Merged from input search term, input start URLs and input ZPIDs; it fallbacks to LABELS.SEARCH,
        // LABELS.DETAIL and LABELS.ZPIDS crawler branches respectively. So we assume that user provided
        // startUrls are pointing to house detail pages only.
        startUrls,
        // On the clean run, this contains only https://www.zillow.com/homes/ and fallbacks to LABELS.INITIAL
        // crawler branch.
        requestQueue,
        // This maps data to expected output shape (see ./src/functions.js#initResultShape), filters out ZPIDs and
        // pushes output data to dataset.
        extendOutputFunction,
        // This passes around variables that are being updated during crawling. # TODO
        extendScraperFunction,
        // This is used when we are in debug mode and it basically just dumps crawled data to KVS - in case that ZPID
        // is not number (eg. unexpected behaviour).
        dump,
        // This function evaluates if we scraped enough items (provided by user in the input `input.maxItems`) and
        // should quit scraping. If `input.maxItems == 0`, we are attempting to scrape all available items.
        isEnoughItemsCollected,
        // This is set during LABELS.INITIAL crawler branch (See ./src/functions.js#createQueryZpid), it sets the
        // function which fetches the data from Zillow graphQL API.
        queryZpid,
        // This might be initialized by the scraped ZPIDs from previous run(s) and is persisted before actor migration.
        // It represents all scraped items, `ZPID` is unique identifier for an listed item (home) on Zillow. See
        // (./src/functions.js#initPersistence).
        zpids,
    } = await initCrawler(input, isDebug, proxyConfig);

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    let isFinishing = false;
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: input.maxRetries || 20,
        handlePageTimeoutSecs: input.handlePageTimeoutSecs || 3600,
        useSessionPool: true,
        proxyConfiguration: proxyConfig,
        launchContext: {
            launchOptions: {
                args: [
                    '--enable-features=NetworkService',
                    '--ignore-certificate-errors',
                    '--disable-blink-features=AutomationControlled', // removes webdriver from window.navigator
                ],
                devtools: isDebug,
                ignoreHTTPSErrors: true,
                useIncognitoPages: true,
                maxOpenPagesPerInstance: 1, // too many connections on the same proxy/session = captcha
            },
            stealth: input.stealth || false,
            userAgent: USER_AGENT,
        },
        // Block unnecessary external API calls such as goolag ads and goolag analytics
        preNavigationHooks: [async ({request, page}, gotoOptions) => {
            await puppeteer.blockRequests(page, {
                extraUrlPatterns: [
                    '.css.map',
                    'www.googletagservices.com',
                    'www.google-analytics.com',
                    'sb.scorecardresearch.com',
                    'cdn.ampproject.org',
                    'pagead2.googlesyndication.com',
                    'tpc.googlesyndication.com',
                    'googleads.g.doubleclick.net',
                    'pxl.jivox.com',
                    'static.ads-twitter.com',
                    'bat.bing.com',
                    'px-cloud.net',
                    'fonts.googleapis.com',
                    'photos.zillowstatic.com',
                    'survata.com',
                    '/collector',
                    'ct.pinterest.com',
                    'sync.ipredictive.com',
                ].concat(request.userData.label === LABELS.DETAIL ? [
                    'maps.googleapis.com',
                    '.js',
                ] : []),
            });

            await extendScraperFunction(undefined, {
                page,
                request,
                label: 'GOTO',
            });

            gotoOptions.timeout = 60000;
            gotoOptions.waitUntil = request.userData.label === LABELS.DETAIL
                ? 'domcontentloaded'
                : 'load';
        }],
        // Scraping is finished
        postNavigationHooks: [async () => {
            if (isEnoughItemsCollected() && !isFinishing) {
                isFinishing = true;
                log.info('Reached maximum items, waiting for finish');
                await Promise.all([
                    crawler.autoscaledPool.pause(),
                    crawler.autoscaledPool.resolve(),
                ]);
            }
        }],
        // Captcha defense
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
        },
        maxConcurrency: 1,
        handlePageFunction: async (
            {
                page,
                request,
                browserController,
                crawler: {autoscaledPool},
                session,
                response,
                proxyInfo
            }
        ) => {
            if (!response || isEnoughItemsCollected()) {
                await page.close();
                return;
            }

            const retire = async () => {
                session.retire();
                await browserController.close();
            };

            // Retire browser if captcha is found
            if (await page.$('.captcha-container')) {
                await retire();
                throw 'Captcha found, retrying...';
            }

            let anyErrors = false;

            /**
             * Extract home data by ZPID
             * @param {string} zpid
             * @param {string} detailUrl
             */
            const processZpid = async (zpid, detailUrl) => {
                if (isEnoughItemsCollected()) {
                    return;
                }

                try {
                    if (+zpid != zpid) {
                        throw 'Invalid non-numeric zpid';
                    }

                    if (zpids.has(`${zpid}`)) {
                        return;
                    }

                    if (!session.isUsable()) {
                        throw 'Not trying to retrieve data';
                    }

                    await extendOutputFunction(
                        JSON.parse(await queryZpid(page, zpid)).data.property,
                        {
                            request,
                            page,
                            zpid,
                        },
                    );
                } catch (e) {
                    anyErrors = true;
                    session.markBad();
                    log.debug('processZpid', {error: e});

                    if (isEnoughItemsCollected()) {
                        return;
                    }

                    // add as a separate detail for retrying
                    await requestQueue.addRequest({
                        url: new URL(detailUrl || `/homedetails/${zpid}_zpid/`, 'https://www.zillow.com').toString(),
                        userData: {
                            label: LABELS.DETAIL,
                            zpid: +zpid,
                        },
                    }, {forefront: true});
                }
            };

            const {label} = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                log.info('Trying to get queryId...');

                const {queryId, clientVersion} = await interceptQueryId(page);

                log.debug('Intercepted queryId', {queryId, clientVersion});

                queryZpid = createQueryZpid(queryId, clientVersion, await page.cookies());

                autoscaledPool.maxConcurrency = 5;

                // now that we initialized, we can add the requests
                for (const req of startUrls) {
                    await requestQueue.addRequest(req);
                }

                log.info('Got queryId, continuing...');
            } else if (label === LABELS.DETAIL) {
                if (isEnoughItemsCollected()) {
                    return;
                }

                log.info(`Scraping ${page.url()}`);

                if (request.url.startsWith('/b/') || !+request.userData.zpid) {
                    const nextData = await page.$eval('[id="__NEXT_DATA__"]', (s) => JSON.parse(s.innerHTML));

                    if (!nextData) {
                        throw 'Missing data';
                    }

                    // legacy layout, need re-enqueue
                    const zpid = _.get(nextData, 'props.initialData.building.zpid');

                    if (zpid) {
                        const url = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

                        const rq = await requestQueue.addRequest({
                            url,
                            userData: {
                                label: LABELS.DETAIL,
                                zpid: +zpid,
                            },
                        }, {forefront: true});

                        if (!rq.wasAlreadyPresent) {
                            log.info(`Re-enqueueing ${url}`);
                        }

                        return;
                    }

                    throw 'ZPID not found in page';
                }

                const scripts = await page.$x('//script[contains(., "RenderQuery") and contains(., "apiCache")]');

                // await Apify.setValue(`${request.userData.zpid}--${Math.random()}`, await page.content(), { contentType: 'text/html' });

                if (!scripts.length) {
                    await retire();
                    throw 'Failed to load preloaded data scripts';
                }

                log.info(`Extracting data from ${request.url}`);
                let noScriptsFound = true;

                for (const script of scripts) {
                    try {
                        const loaded = JSON.parse(JSON.parse(await script.evaluate((s) => s.innerHTML)).apiCache);

                        for (const key in loaded) { // eslint-disable-line
                            if (key.includes('RenderQuery') && loaded[key].property) {
                                await extendOutputFunction(loaded[key].property, {
                                    request,
                                    page,
                                    zpid: request.userData.zpid,
                                });

                                noScriptsFound = false;
                                break;
                            }
                        }
                    } catch (e) {
                        if (e.message.includes('Cannot read property')) {
                            // this is a faulty extend output function
                            log.error(`Your Extend Output Function errored:\n\n    ${e}\n\n`, {url: page.url()});
                        }
                        log.debug(e);
                    }
                }

                if (noScriptsFound) {
                    throw 'Failed to load preloaded data from page';
                }
            } else if (label === LABELS.ZPIDS) {
                // Extract all homes by input ZPIDs
                log.info(`Scraping ${input.zpids.length} zpids`);

                for (const zpid of input.zpids) {
                    await processZpid(zpid, '');

                    if (isEnoughItemsCollected()) {
                        break;
                    }
                }
            } else if (label === LABELS.QUERY || label === LABELS.SEARCH) {
                if (label === LABELS.SEARCH) {
                    log.info(`Searching for "${request.userData.term}"`);

                    const text = '#search-box-input';
                    const btn = 'button#search-icon';

                    await Promise.all([
                        page.waitForSelector(text),
                        page.waitForSelector(btn),
                    ]);

                    await page.focus(text);
                    await page.type(text, request.userData.term, {delay: 100});

                    await sleep(3000);

                    try {
                        await Promise.all([
                            page.waitForNavigation({timeout: 15000}),
                            page.tap(btn),
                        ]);
                    } catch (e) {
                        await retire();
                        throw 'Search didn\'t redirect, retrying...';
                    }

                    if (!/(\/homes\/|_rb)/.test(page.url()) || page.url().includes('/_rb/')) {
                        await retire();
                        throw `Unexpected page address ${page.url()}, use a better keyword for searching or proper state or city name. Will retry...`;
                    }

                    if (await page.$('.captcha-container')) {
                        await retire();
                        throw 'Captcha found when searching, retrying...';
                    }
                }

                // Get initial searchState
                let qs = request.userData.queryState;
                let searchState;
                let shouldContinue = true;

                try {
                    const pageQs = await page.evaluate(() => {
                        try {
                            return JSON.parse(
                                document.querySelector(
                                    'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
                                ).innerHTML.slice(4, -3),
                            );
                        } catch (e) {
                            return {};
                        }
                    });

                    const results = _.get(pageQs, 'cat1.searchResults.listResults', []);

                    for (const {zpid, detailUrl} of results) {
                        await dump(zpid, results);

                        if (zpid) {
                            if (isEnoughItemsCollected()) {
                                shouldContinue = false;
                                break;
                            }
                            await processZpid(zpid, detailUrl);
                        }
                    }

                    if (shouldContinue) {
                        qs = qs || pageQs.queryState;

                        if (!qs) {
                            throw 'Query state is empty';
                        }

                        log.debug('queryState', {qs});

                        const result = await page.evaluate(
                            queryRegionHomes,
                            {
                                qs,
                                // use a special type so the query state that comes from the url
                                // doesn't get erased
                                type: request.userData.queryState ? 'qs' : input.type,
                            },
                        );

                        log.debug('query', result.qs);

                        searchState = JSON.parse(result.body);
                        qs = result.qs;
                    }
                } catch (e) {
                    log.debug(e);
                }

                if (shouldContinue) {
                    // Check mapResults
                    const results = [
                        ..._.get(
                            searchState,
                            'cat1.searchResults.mapResults',
                            [],
                        ),
                        ..._.get(
                            searchState,
                            'cat1.searchResults.listResults',
                            [],
                        ),
                    ];

                    if (!results || !results.length) {
                        await retire();
                        throw `No map results at ${JSON.stringify(qs.mapBounds)}`;
                    }

                    log.info(`Searching homes at ${JSON.stringify(qs.mapBounds)}`);

                    // Extract home data from mapResults
                    const thr = input.splitThreshold || 500;

                    if (results.length >= thr) {
                        if (input.maxLevel && (request.userData.splitCount || 0) >= input.maxLevel) {
                            log.info('Over max level');
                        } else {
                            // Split map and enqueue sub-rectangles
                            const splitCount = (request.userData.splitCount || 0) + 1;
                            const split = [
                                ...splitQueryState(qs),
                                ...splitQueryState(request.userData.queryState),
                            ];

                            for (const queryState of split) {
                                if (isEnoughItemsCollected()) {
                                    break;
                                }

                                const uniqueKey = quickHash(`${request.url}${splitCount}${JSON.stringify(queryState)}`);
                                log.debug('queryState', {queryState, uniqueKey});

                                await requestQueue.addRequest({
                                    url: request.url,
                                    userData: {
                                        queryState,
                                        label: LABELS.QUERY,
                                        splitCount,
                                    },
                                    uniqueKey,
                                });
                            }
                        }
                    }

                    if (results.length > 0) {
                        const extracted = () => {
                            log.info(`Extracted total ${zpids.size}`);
                        };
                        const interval = setInterval(extracted, 10000);

                        try {
                            for (const {zpid, detailUrl} of results) {
                                await dump(zpid, results);

                                if (zpid) {
                                    await processZpid(zpid, detailUrl);

                                    if (isEnoughItemsCollected()) {
                                        break; // optimize runtime
                                    }
                                }
                            }
                        } finally {
                            if (!anyErrors) {
                                extracted();
                            }
                            clearInterval(interval);
                        }
                    }
                }
            }

            await extendScraperFunction(undefined, {
                page,
                request,
                retire,
                processZpid,
                queryZpid,
                queryRegionHomes,
                label: 'HANDLE',
            });

            if (anyErrors) {
                await retire();
                throw 'Retiring session and browser...';
            }
        },
        handleFailedRequestFunction: async ({request}) => {
            // This function is called when the crawling of a request failed too many times
            log.error(`\n\nRequest ${request.url} failed too many times.\n\n`);
        },
    });

    // Start crawling
    await crawler.run();

    await extendScraperFunction(undefined, {
        label: 'FINISH',
        crawler,
    });

    if (!queryZpid) {
        // this usually means the proxy is busted, we need to fail
        throw new Error('The selected proxy group seems to be blocked, try a different one or contact Apify on Intercom');
    }

    log.info(`Done with ${zpids.size} listings!`);
});
