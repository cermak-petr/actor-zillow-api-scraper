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
    });

    const isOverItems = (extra = 0) => (input.maxItems && (zpids.size + extra) >= input.maxItems);

    const extendOutputFunction = await extendFunction({
        map: async (data) => {
            return getSimpleResult(data);
        },
        filter: async ({ data }) => {
            if (isOverItems()) {
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

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: input.maxRetries || 20,
        handlePageTimeoutSecs: input.handlePageTimeoutSecs || 3600,
        useSessionPool: true,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1,
        },
        proxyConfiguration: proxyConfig,
        launchPuppeteerFunction: async (options) => {
            return Apify.launchPuppeteer({
                ...options,
                userAgent: USER_AGENT,
                args: [
                    ...options.args,
                    '--enable-features=NetworkService',
                    '--ignore-certificate-errors',
                    '--disable-blink-features=AutomationControlled', // removes webdriver from window.navigator
                ],
                devtools: isDebug,
                ignoreHTTPSErrors: true,
                stealth: input.stealth || false,
            });
        },
        gotoFunction: async ({ page, request, puppeteerPool, session }) => {
            await puppeteer.blockRequests(page, {
                extraUrlPatterns: [
                    '.css.map',
                    // 'maps.googleapis.com', // needed
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
                ],
            });

            await page.emulate({
                userAgent: USER_AGENT,
                viewport: {
                    height: 1080,
                    width: 1920,
                },
            });

            await extendScraperFunction(undefined, {
                page,
                request,
                label: 'GOTO',
            });

            try {
                return await page.goto(request.url, {
                    waitUntil: 'load',
                    timeout: 60000,
                });
            } catch (e) {
                session.retire();
                await puppeteerPool.retire(page.browser());
                throw e;
            }
        },
        maxConcurrency: 1,
        handlePageFunction: async ({ page, request, puppeteerPool, autoscaledPool, session }) => {
            const retire = async () => {
                session.retire();
                await puppeteerPool.retire(page.browser());
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
             */
            const processZpid = async (zpid) => {
                if (isOverItems()) {
                    return;
                }

                if (zpids.has(`${zpid}`)) {
                    return;
                }

                try {
                    if (!session.isUsable()) {
                        session.retire();
                        throw 'Retiring session';
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

                    // add as a separate detail for retrying
                    await requestQueue.addRequest({
                        url: `https://www.zillow.com/homedetails/${zpid}_zpid/`,
                        userData: {
                            label: LABELS.DETAIL,
                            zpid,
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

                if (!isDebug) {
                    autoscaledPool.maxConcurrency = 100;
                }

                // now that we initialized, we can add the requests
                for (const req of startUrls) {
                    await requestQueue.addRequest(req);
                }

                log.info('Got queryId, continuing...');
            } else if (label === LABELS.DETAIL) {
                const scripts = await page.$x('//script[contains(., "RenderQuery") and contains(., "apiCache")]');

                if (!scripts.length) {
                    await retire();
                    throw 'Failed to load preloaded data';
                }

                log.info(`Extracting data from ${request.url}`);
                let noScriptsFound = true;

                try {
                    for (const script of scripts) {
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
                    }
                } catch (e) {
                    log.debug(e);
                    await retire();
                }

                if (noScriptsFound) {
                    throw 'Failed to load preloaded data';
                }
            } else if (label === LABELS.ZPIDS) {
                // Extract all homes by input ZPIDs

                for (const zpid of input.zpids) {
                    await processZpid(zpid);

                    if (isOverItems()) {
                        break;
                    }
                }
            } else if (label === LABELS.QUERY || label === LABELS.SEARCH) {
                if (label === LABELS.SEARCH) {
                    log.info(`Searching for "${request.userData.term}"`);

                    const text = '#search-box-input';
                    const btn = '[aria-label="Submit Search"]';

                    await Promise.all([
                        page.waitForSelector(text),
                        page.waitForSelector(btn),
                    ]);

                    await page.focus(text);
                    await page.type(text, request.userData.term, { delay: 100 });

                    await sleep(3000);

                    await Promise.all([
                        page.waitForNavigation({ timeout: 60000 }),
                        page.click(btn),
                    ]);

                    if (!/(\/homes\/|_rb)/.test(page.url()) || page.url().includes('/homes/_rb/') || await page.$('.captcha-container')) {
                        throw 'Page didn\'t load properly, retrying...';
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

                    if (results.length) {
                        log.info(`Going to parse ${results.length} results...`);
                    }

                    for (const { zpid } of results) {
                        if (zpid) {
                            if (isOverItems()) {
                                shouldContinue = false;
                                break;
                            }
                            await processZpid(zpid);
                        }
                    }

                    if (shouldContinue) {
                        qs = qs || pageQs.queryState;

                        if (!qs) {
                            throw 'Query state is empty';
                        }

                        searchState = JSON.parse(await page.evaluate(
                            queryRegionHomes,
                            { qs, type: input.type },
                        ));
                    }
                } catch (e) {
                    await retire();
                    log.debug(e);
                    throw `Unable to get searchState, retrying...\n${e.message || e}`;
                }

                if (shouldContinue && !isOverItems()) {
                    // Check mapResults
                    const { mapResults } = searchState.searchResults;
                    if (!mapResults) {
                        await retire();
                        throw `No map results at ${JSON.stringify(qs.mapBounds)}`;
                    }

                    log.info(`Searching homes at ${JSON.stringify(qs.mapBounds)}`);

                    // Extract home data from mapResults
                    const thr = input.splitThreshold || 500;

                    if (
                        mapResults.length < thr
                        || input.maxLevel === 0
                        || (input.maxLevel
                            && (request.userData.splitCount || 0) >= input.maxLevel)
                    ) {
                        if (mapResults.length > 0) {
                            log.info(
                                `Found ${mapResults.length} homes, extracting data...`,
                            );

                            const extracted = () => {
                                log.info(`Extracted total ${zpids.size}`);
                            };
                            const interval = setInterval(extracted, 10000);

                            try {
                                for (const { zpid } of mapResults) {
                                    if (zpid) {
                                        await processZpid(zpid);

                                        if (isOverItems()) {
                                            break; // optimize runtime
                                        }
                                    }
                                }
                            } finally {
                                extracted();
                                clearInterval(interval);
                            }
                        }
                    } else {
                        // Split map and enqueue sub-rectangles
                        log.info(`Found more than ${thr} homes, splitting map...`);
                        let localCount = 0;

                        for (const queryState of splitQueryState(qs)) {
                            const splitCount = (request.userData.splitCount || 0) + 1;

                            await requestQueue.addRequest({
                                url: request.url,
                                userData: {
                                    queryState,
                                    label: LABELS.QUERY,
                                    splitCount,
                                },
                                uniqueKey: quickHash(`${request.url}${splitCount}${queryState}`),
                            });

                            if (isOverItems(localCount++ * thr)) {
                                break;
                            }
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

    log.info('Done!');
});
