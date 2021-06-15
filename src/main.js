const Apify = require('apify');
const _ = require('lodash');
const {handleInitialCrawl} = require("./crawler/init");
const {RetireError, handleDetailCrawl} = require("./crawler/details");
const {
    initProxyConfig,
    initCrawler
} = require("./crawler/init");
const {LABELS, USER_AGENT} = require('./constants');
const {
    queryRegionHomes,
    splitQueryState,
    quickHash,
    isEnoughItemsCollected,
    processZpid,
    retire,
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
        // This is set during LABELS.INITIAL crawler branch (See ./src/functions.js#createQueryZpid), it sets the
        // function which fetches the data from Zillow graphQL API.
        queryZpid,
        // This might be initialized by the scraped ZPIDs from previous run(s) and is persisted before actor migration.
        // It represents all scraped items, `ZPID` is unique identifier for an listed item (home) on Zillow. See
        // (./src/functions.js#initPersistence).
        zpids,
        // Maximum number of scraped items (homes). If 0 or not number, attempt to scrape all available items.
        maxItems,
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
            if (isEnoughItemsCollected(maxItems, zpids) && !isFinishing) {
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
            // Either there is no response or we have already scraped the desired product count
            if (!response || isEnoughItemsCollected(maxItems, zpids)) {
                await page.close();
                return;
            }

            // Retire browser if captcha is found
            if (await page.$('.captcha-container')) {
                await retire(session, browserController);
                throw 'Captcha found, retrying...';
            }

            let anyErrors = false;

            /**
             * Extract home data by ZPID
             * @param {string} zpid
             * @param {string} detailUrl
             */
            const {label} = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                // LABELS.INITIAL: Get queryZpid to be able to use zillow graphql
                queryZpid = await handleInitialCrawl(page, requestQueue, startUrls, autoscaledPool);
            } else if (label === LABELS.DETAIL) {
                // LABELS.DETAIL: Crawl
                if (isEnoughItemsCollected(maxItems, zpids)) {
                    return;
                }
                //todo generic
                try {
                    await handleDetailCrawl(page, request, requestQueue, extendOutputFunction);
                } catch (e) {
                    if (e instanceof RetireError) {
                        await retire(session, browserController)
                    } else {
                        throw e;
                    }
                }
            } else if (label === LABELS.ZPIDS) {
                // Extract all homes by input ZPIDs
                log.info(`Scraping ${input.zpids.length} zpids`);

                for (const zpid of input.zpids) {
                    anyErrors = await processZpid(
                        request, page, extendOutputFunction, queryZpid, requestQueue, zpid, ''
                    );

                    if (isEnoughItemsCollected(maxItems, zpids)) {
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
                            if (isEnoughItemsCollected(maxItems, zpids)) {
                                shouldContinue = false;
                                break;
                            }
                            anyErrors = await processZpid(
                                request, page, extendOutputFunction, queryZpid, requestQueue, zpid, detailUrl
                            );
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
                                if (isEnoughItemsCollected(maxItems, zpids)) {
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
                                    anyErrors = await processZpid(
                                        request, page, extendOutputFunction, queryZpid, requestQueue, zpid, detailUrl
                                    );

                                    if (isEnoughItemsCollected(maxItems, zpids)) {
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
