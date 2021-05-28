const Apify = require('apify');
const _ = require('lodash');
const { LABELS, TYPES, USER_AGENT } = require('./constants');
const {
    createGetSimpleResult,
    createQueryZpid,
    proxyConfiguration,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    quickHash,
    getUrlData,
    extendFunction,
    makeInputBackwardsCompatible,
} = require('./functions');

const { log, puppeteer, sleep } = Apify.utils;

Apify.main(async () => {
    /**
     * @type {any}
     */
    const input = await Apify.getInput();

    const isDebug = Apify.utils.log.getLevel() === Apify.utils.log.LEVELS.DEBUG;

    // Check input
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids) {
        throw new Error('Either "search", "startUrls" or "zpids" attribute has to be set!');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: {
            ...input.proxyConfiguration,
        },
        hint: ['RESIDENTIAL'],
    });

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = 'US';
    }

    // Initialize minimum time
    const minTime = input.minDate
        ? (+input.minDate || new Date(input.minDate).getTime())
        : null;

    // Toggle showing only a subset of result attriutes
    const getSimpleResult = createGetSimpleResult(
        input.simple
            ? {
                address: true,
                bedrooms: true,
                bathrooms: true,
                price: true,
                yearBuilt: true,
                longitude: true,
                homeStatus: true,
                latitude: true,
                description: true,
                livingArea: true,
                currency: true,
                hdpUrl: true,
                hugePhotos: true,
            }
            : {
                datePosted: true,
                isZillowOwned: true,
                priceHistory: true,
                zpid: true,
                homeStatus: true,
                address: true,
                bedrooms: true,
                bathrooms: true,
                price: true,
                yearBuilt: true,
                isPremierBuilder: true,
                longitude: true,
                latitude: true,
                description: true,
                primaryPublicVideo: true,
                tourViewCount: true,
                postingContact: true,
                unassistedShowing: true,
                livingArea: true,
                currency: true,
                homeType: true,
                comingSoonOnMarketDate: true,
                timeZone: true,
                hdpUrl: true,
                newConstructionType: true,
                moveInReady: true,
                moveInCompletionDate: true,
                hugePhotos: true,
                lastSoldPrice: true,
                contingentListingType: true,
                zestimate: true,
                zestimateLowPercent: true,
                zestimateHighPercent: true,
                rentZestimate: true,
                restimateLowPercent: true,
                restimateHighPercent: true,
                solarPotential: true,
                brokerId: true,
                parcelId: true,
                homeFacts: true,
                taxAssessedValue: true,
                taxAssessedYear: true,
                isPreforeclosureAuction: true,
                listingProvider: true,
                marketingName: true,
                building: true,
                priceChange: true,
                datePriceChanged: true,
                dateSold: true,
                lotSize: true,
                hoaFee: true,
                mortgageRates: true,
                propertyTaxRate: true,
                whatILove: true,
                isFeatured: true,
                isListedByOwner: true,
                isCommunityPillar: true,
                pageViewCount: true,
                favoriteCount: true,
                openHouseSchedule: true,
                brokerageName: true,
                taxHistory: true,
                abbreviatedAddress: true,
                ownerAccount: true,
                isRecentStatusChange: true,
                isNonOwnerOccupied: true,
                buildingId: true,
                daysOnZillow: true,
                rentalApplicationsAcceptedType: true,
                buildingPermits: true,
                highlights: true,
                tourEligibility: true,
            },
    );

    const zpids = new Set(await Apify.getValue('STATE'));

    Apify.events.on('migrating', async () => {
        await Apify.setValue('STATE', [...zpids.values()]);
    });

    // TODO: temp hack to get around empty output. remove this after merge to master
    makeInputBackwardsCompatible(input);

    const requestQueue = await Apify.openRequestQueue();

    /**
     * @type {Apify.RequestOptions[]}
     */
    const startUrls = [];

    if (input.search && input.search.trim()) {
        const term = input.search.trim();

        startUrls.push({
            url: 'https://www.zillow.com',
            uniqueKey: `${term}`,
            userData: {
                label: LABELS.SEARCH,
                term,
            },
        });
    }

    if (input.startUrls && input.startUrls.length) {
        const requestList = await Apify.openRequestList('STARTURLS', input.startUrls);

        let req;
        while (req = await requestList.fetchNextRequest()) { // eslint-disable-line no-cond-assign
            if (!req.url.includes('zillow.com')) {
                throw new Error(`Invalid startUrl ${req.url}`);
            }

            startUrls.push({
                url: req.url,
                userData: getUrlData(req.url),
            });
        }
    }

    if (input.zpids && input.zpids.length) {
        startUrls.push({
            url: 'https://www.zillow.com/',
            uniqueKey: 'ZPIDS',
            userData: {
                label: LABELS.ZPIDS,
            },
        });
    }

    /**
     * @type {ReturnType<typeof createQueryZpid>}
     */
    let queryZpid = null;

    await requestQueue.addRequest({
        url: 'https://www.zillow.com/homes/',
        uniqueKey: `${Math.random()}`,
        userData: {
            label: LABELS.INITIAL,
        },
    }, { forefront: true });

    const isOverItems = (extra = 0) => (typeof input.maxItems === 'number' && input.maxItems > 0
        ? (zpids.size + extra) >= input.maxItems
        : false);

    const extendOutputFunction = await extendFunction({
        map: async (data) => {
            return getSimpleResult(data);
        },
        filter: async ({ data }) => {
            if (isOverItems()) {
                return false;
            }

            if (!_.get(data, 'zpid')) {
                return false;
            }

            return (minTime ? data.datePosted <= minTime : true)
                && !zpids.has(`${data.zpid}`);
        },
        output: async (output, { data }) => {
            zpids.add(`${data.zpid}`);
            await Apify.pushData(output);
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            _,
            zpids,
            minTime,
            TYPES,
            LABELS,
        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            proxyConfig,
            startUrls,
            getUrlData,
            requestQueue,
            get queryZpid() {
                // if we use the variable here won't change to the actual function
                // and will always get null
                return queryZpid;
            },
            getSimpleResult,
            zpids,
            _,
            extendOutputFunction,
            minTime,
        },
    });

    const dump = Apify.utils.log.LEVELS.DEBUG === Apify.utils.log.getLevel() ? async (zpid, data) => {
        if (typeof zpid !== 'number') {
            await Apify.setValue(`DUMP-${Math.random()}`, data);
        }
    } : () => {};

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    let isFinishing = false;

    // Create crawler
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
        preNavigationHooks: [async ({ request, page }, gotoOptions) => {
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
        postNavigationHooks: [async () => {
            if (isOverItems() && !isFinishing) {
                isFinishing = true;
                log.info('Reached maximum items, waiting for finish');
                await Promise.all([
                    crawler.autoscaledPool.pause(),
                    crawler.autoscaledPool.resolve(),
                ]);
            }
        }],
        browserPoolOptions: {
            maxOpenPagesPerBrowser: 1,
        },
        maxConcurrency: 1,
        handlePageFunction: async ({ page, request, browserController, crawler: { autoscaledPool }, session, response, proxyInfo }) => {
            if (!response || isOverItems()) {
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
                if (isOverItems()) {
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
                    log.debug('processZpid', { error: e });

                    if (isOverItems()) {
                        return;
                    }

                    // add as a separate detail for retrying
                    await requestQueue.addRequest({
                        url: new URL(detailUrl || `/homedetails/${zpid}_zpid/`, 'https://www.zillow.com').toString(),
                        userData: {
                            label: LABELS.DETAIL,
                            zpid: +zpid,
                        },
                    }, { forefront: true });
                }
            };

            const { label } = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                log.info('Trying to get queryId...');

                const { queryId, clientVersion } = await interceptQueryId(page);

                log.debug('Intercepted queryId', { queryId, clientVersion });

                queryZpid = createQueryZpid(queryId, clientVersion, await page.cookies());

                autoscaledPool.maxConcurrency = 5;

                // now that we initialized, we can add the requests
                for (const req of startUrls) {
                    await requestQueue.addRequest(req);
                }

                log.info('Got queryId, continuing...');
            } else if (label === LABELS.DETAIL) {
                if (isOverItems()) {
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
                        }, { forefront: true });

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
                            log.error(`Your Extend Output Function errored:\n\n    ${e}\n\n`, { url: page.url() });
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

                    if (isOverItems()) {
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
                    await page.type(text, request.userData.term, { delay: 100 });

                    await sleep(3000);

                    try {
                        await Promise.all([
                            page.waitForNavigation({ timeout: 15000 }),
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

                    for (const { zpid, detailUrl } of results) {
                        await dump(zpid, results);

                        if (zpid) {
                            if (isOverItems()) {
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

                        log.debug('queryState', { qs });

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
                                if (isOverItems()) {
                                    break;
                                }

                                const uniqueKey = quickHash(`${request.url}${splitCount}${JSON.stringify(queryState)}`);
                                log.debug('queryState', { queryState, uniqueKey });

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
                            for (const { zpid, detailUrl } of results) {
                                await dump(zpid, results);

                                if (zpid) {
                                    await processZpid(zpid, detailUrl);

                                    if (isOverItems()) {
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
        handleFailedRequestFunction: async ({ request }) => {
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
