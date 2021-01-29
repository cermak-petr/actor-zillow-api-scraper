const Apify = require('apify');
const { LABELS } = require('./constants');
const {
    createGetSimpleResult,
    createQueryZpid,
    proxyConfiguration,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    quickHash,
} = require('./functions');

const { log, puppeteer } = Apify.utils;

Apify.main(async () => {
    /**
     * @type {any}
     */
    const input = await Apify.getInput();
    /**
     * @type {{ extractedZpids: Record<string, boolean>, resultCount: number }}
     */
    const state = /** @type {any} */(await Apify.getValue('STATE')) || {
        extractedZpids: {},
        resultCount: 0,
    };

    Apify.events.on('migrating', () => {
        Apify.setValue('STATE', state);
    });

    // Check input
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids) {
        throw new Error('Either "search", "startUrls" or "zpids" attribute has to be set!');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: input.proxyConfiguration,
    });

    // Initialize minimum time
    const minTime = input.minDate
        ? (+input.minDate || new Date(input.minDate).getTime())
        : null;

    // Parse extendOutpudFunction
    /**
     * @type {null | ((...args: any) => any)}
     */
    let extendOutputFunction = null;
    if (input.extendOutputFunction) {
        try { extendOutputFunction = eval(input.extendOutputFunction); } catch (e) { throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`); }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default output!');
        }
    }

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

    const requestQueue = await Apify.openRequestQueue();

    /**
     * @type {Apify.RequestOptions[]}
     */
    const startUrls = [];

    if (input.search) {
        const term = input.search.trim().replace(/,(\s*)/g, '-').replace(/\s+/, '+').toLowerCase();
        // const term = encodeURIComponent(input.search.trim());
        startUrls.push({
            url: `https://www.zillow.com/homes/${term}${(input.type === 'rent' ? '/rentals' : '')}`,
            userData: {
                label: 'QUERY',
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
                userData: {
                    label: 'QUERY',
                },
            });
        }
    }

    if (input.zpids && input.zpids.length) {
        startUrls.push({
            url: 'https://www.zillow.com/homes/',
            uniqueKey: 'ZPIDS',
            userData: {
                label: 'ZPIDS',
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

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: 20,
        handlePageTimeoutSecs: 3600,
        useSessionPool: true,
        proxyConfiguration: proxyConfig,
        launchPuppeteerOptions: {
            devtools: Apify.utils.log.getLevel() === Apify.utils.log.LEVELS.DEBUG,
            useChrome: Apify.isAtHome(),
            stealth: true,
        },
        gotoFunction: async ({ page, request }) => {
            await puppeteer.blockRequests(page, {
                extraUrlPatterns: [
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
                ],
            });

            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.104 Safari/537.36',
            );

            return page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000,
            });
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

            /**
             * Extract home data by ZPID
             * @param {string} zpid
             * @param {number} index
             */
            const processZpid = async (zpid, index) => {
                try {
                    const homeData = await queryZpid(page, zpid);

                    if (minTime && homeData.data.property.datePosted <= minTime) { return; }
                    const result = getSimpleResult(homeData.data.property);

                    if (extendOutputFunction) {
                        try {
                            Object.assign(result, await extendOutputFunction(homeData.data));
                        } catch (e) {
                            log.exception(e, 'extendOutputFunction error:');
                        }
                    }

                    await Apify.pushData(result);
                    state.extractedZpids[zpid] = true;
                    if (input.maxItems && ++state.resultCount >= input.maxItems) {
                        await autoscaledPool.abort();
                    }
                } catch (e) {
                    log.warning(`Data extraction failed - zpid: ${zpid}`, { message: e.message });
                    await retire();
                    await requestQueue.addRequest({
                        url: request.url,
                        uniqueKey: `${request.url}${index}`,
                        userData: Object.assign(request.userData, { start: index }),
                    });
                }
            };

            const { label } = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                const { queryId, clientVersion } = await interceptQueryId(page);
                log.debug('Intercepted queryId', { queryId, clientVersion });

                queryZpid = createQueryZpid(queryId, clientVersion, await page.cookies());

                // now that we initialized, we can add the requests
                for (const req of startUrls) {
                    await requestQueue.addRequest(req);
                }

                autoscaledPool.maxConcurrency = 100;
            } else if (label === LABELS.ZPIDS) {
                // Extract all homes by input ZPIDs
                const start = request.userData.start || 0;
                if (start) {
                    log.info(`Starting at ${start}`);
                }

                for (let i = start; i < input.zpids.length; i++) {
                    const zpid = input.zpids[i];
                    await processZpid(zpid, i);
                }
            } else if (label === LABELS.QUERY) {
                // Get initial searchState
                let qs = request.userData.queryState;
                let searchState;

                try {
                    if (!qs) {
                        qs = await page.evaluate(() => {
                            return JSON.parse(
                                document.querySelector(
                                    'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
                                ).innerHTML.slice(4, -3),
                            ).queryState;
                        });
                    }

                    searchState = JSON.parse(await page.evaluate(
                        queryRegionHomes,
                        { qs, type: input.type },
                    ));
                } catch (e) {
                    await retire();
                    log.debug(e);
                    throw 'Unable to get searchState, retrying...';
                }

                // Check mapResults
                const { mapResults } = searchState.searchResults;
                if (!mapResults) {
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
                    log.info(
                        `Found ${mapResults.length} homes, extracting data...`,
                    );
                    const start = request.userData.start || 0;
                    if (start) {
                        log.info(`Starting at ${start}`);
                    }
                    for (let i = start; i < mapResults.length; i++) {
                        const home = mapResults[i];
                        if (home.zpid && !state.extractedZpids[home.zpid]) {
                            await processZpid(home.zpid, i);
                        }
                    }
                } else {
                    // Split map and enqueue sub-rectangles
                    log.info(`Found more than ${thr} homes, splitting map...`);
                    for (const queryState of splitQueryState(qs)) {
                        const splitCount = (request.userData.splitCount || 0) + 1;
                        await requestQueue.addRequest({
                            url: request.url,
                            userData: {
                                queryState,
                                label: LABELS.QUERY,
                                splitCount,
                            },
                            uniqueKey: `${request.url}${splitCount}${quickHash(queryState)}`,
                        });
                    }
                }
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            // This function is called when the crawling of a request failed too many times
            log.error(`Request ${request.url} failed too many times.`);
        },
    });

    // Start crawling
    await crawler.run();

    log.info('Done!');
});
