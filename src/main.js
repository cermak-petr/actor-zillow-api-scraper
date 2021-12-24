const Apify = require('apify');
const HeaderGenerator = require('header-generator');
const _ = require('lodash');
const { LABELS, TYPES, INITIAL_URL } = require('./constants');
const { getExtendOutputFunction } = require('./extend-functions');
const fns = require('./functions');
const handlePageFns = require('./page-handler');

const {
    createGetSimpleResult,
    createQueryZpid,
    proxyConfiguration,
    splitQueryState,
    quickHash,
    getUrlData,
    extendFunction,
    extractQueryStates,
} = fns;

const {
    PageHandler,
    handleInitialPage,
    handleDetailPage,
} = handlePageFns;

const { log, puppeteer, sleep } = Apify.utils;

Apify.main(async () => {
    /**
     * @type {any}
     */
    const input = await Apify.getInput();

    if (input.debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const isDebug = input.debugLog === true;

    // Check input
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids) {
        throw new Error('Either "search", "startUrls" or "zpids" attribute has to be set!');
    }

    const proxyConfig = await proxyConfiguration({
        proxyConfig: {
            ...input.proxyConfiguration,
        },
    });

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = 'US';
    }

    // Initialize minimum time
    const minMaxDate = fns.minMaxDates({
        min: input.minDate,
        max: input.maxDate,
    });

    // Toggle showing only a subset of result attributes

    const simpleResult = {
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
    };

    const getSimpleResult = createGetSimpleResult(
        input.simple
            ? simpleResult
            : {
                ...simpleResult,
                datePosted: true,
                isZillowOwned: true,
                priceHistory: true,
                zpid: true,
                isPremierBuilder: true,
                primaryPublicVideo: true,
                tourViewCount: true,
                postingContact: true,
                unassistedShowing: true,
                homeType: true,
                comingSoonOnMarketDate: true,
                timeZone: true,
                newConstructionType: true,
                moveInReady: true,
                moveInCompletionDate: true,
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

    // should store biggest discovered zpids count (typically from the first loaded search page before map splitting)
    let maxZpidsFound = 0;

    const globalContext = {
        zpids,
        input,
        maxZpidsFound,
    };

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
        if (input.type) {
            log.warning(`Input type "${input.type}" will be ignored as the value is derived from start url.
            Check if your start urls match the desired home status.`);
        }

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
    /**
     * @type {any}
     */
    const savedQueryId = await Apify.getValue('QUERY');

    if (savedQueryId?.queryId && savedQueryId?.clientVersion) {
        queryZpid = createQueryZpid(savedQueryId.queryId, savedQueryId.clientVersion);
    } else {
        await requestQueue.addRequest({
            url: INITIAL_URL,
            uniqueKey: `${Math.random()}`,
            userData: {
                label: LABELS.INITIAL,
            },
        }, { forefront: true });
    }

    const isOverItems = (extra = 0) => (typeof input.maxItems === 'number' && input.maxItems > 0
        ? (zpids.size + extra) >= input.maxItems
        : false);

    const extendOutputFunction = await getExtendOutputFunction(globalContext, minMaxDate, getSimpleResult);

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
            fns,
            extendOutputFunction,
            minMaxDate,
        },
    });

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    const headerGenerator = new HeaderGenerator({
        browsers: [
            { name: 'chrome', minVersion: 87 },
        ],
        devices: [
            'desktop',
        ],
        operatingSystems: process.platform === 'win32'
            ? ['windows']
            : ['linux'],
    });

    let isFinishing = false;

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: input.maxRetries || 20,
        handlePageTimeoutSecs: !queryZpid
            ? 120
            : input.handlePageTimeoutSecs || 3600,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
                maxErrorScore: 0.5,
            },
        },
        proxyConfiguration: proxyConfig,
        preNavigationHooks: [async ({ request, page }, gotoOptions) => {
            const userAgent = headerGenerator.getHeaders()['user-agent'];
            log.debug(`User-agent: ${userAgent}`);

            await page.setUserAgent(userAgent);

            await puppeteer.blockRequests(page, {
                urlPatterns: [
                    '.gif',
                    '.webp',
                    '.jpeg',
                    '.jpg',
                    '.png',
                    '.ttf',
                    '.css.map',
                    'www.googletagmanager.com',
                    'www.googletagservices.com',
                    'www.googleadservices.com',
                    'www.google-analytics.com',
                    'sb.scorecardresearch.com',
                    'cdn.ampproject.org',
                    'doubleclick.net',
                    'pagead2.googlesyndication.com',
                    'amazon-adsystem.com',
                    'tpc.googlesyndication.com',
                    'googleads.g.doubleclick.net',
                    'pxl.jivox.com',
                    'ib.adnxs.com',
                    'static.ads-twitter.com',
                    'bat.bing.com',
                    'px-cloud.net',
                    'fonts.gstatic.com',
                    'tiqcdn.com',
                    'fonts.googleapis.com',
                    'photos.zillowstatic.com',
                    'survata.com',
                    'zg-api.com',
                    'accounts.google.com',
                    'casalemedia.com',
                    'adsystem.com',
                    '/collector',
                    'tapad.com',
                    'cdn.pdst.fm',
                    'pdst-events-prod-sink',
                    'doubleclick.net',
                    'ct.pinterest.com',
                    'sync.ipredictive.com',
                    'adservice.google.com',
                    'adsrvr.org',
                    'pubmatic.com',
                    'sentry-cdn.com',
                    'api.rlcdn.com',
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

            const { label } = request.userData;

            gotoOptions.timeout = 60000;
            gotoOptions.waitUntil = label === LABELS.DETAIL
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
            preLaunchHooks: [async (pageId, launchContext) => {
                launchContext.launchOptions = {
                    ...launchContext.launchOptions,
                    bypassCSP: true,
                    ignoreHTTPSErrors: true,
                    devtools: input.debugLog,
                    headless: false,
                };

                if (queryZpid !== null) {
                    fns.changeHandlePageTimeout(crawler, input.handlePageTimeoutSecs || 3600);
                }
            }],
            postPageCloseHooks: [async (_pageId, browserController) => {
                if (!browserController?.launchContext?.session?.isUsable()) {
                    log.debug('Session is not usable');
                    await browserController.close();
                }
            }],
        },
        maxConcurrency: !queryZpid ? 1 : 10,
        handlePageFunction: async ({ page, request, crawler: { autoscaledPool }, session, response, proxyInfo }) => {
            if (!response || isOverItems()) {
                await page.close();
                if (!response) {
                    throw new Error('No response from page');
                }
                return;
            }

            // Retire browser if captcha is found
            if (await page.$('.captcha-container')) {
                session.retire();
                throw new Error('Captcha found, retrying...');
            }

            const context = { page, request, crawler: { requestQueue, autoscaledPool }, session, response, proxyInfo };
            const pageHandler = new PageHandler(context, globalContext, extendOutputFunction);

            const { label } = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                queryZpid = await pageHandler.handleInitialPage(queryZpid, startUrls);
            } else if (label === LABELS.DETAIL) {
                await pageHandler.handleDetailPage();
            } else if (label === LABELS.ZPIDS) {
                await pageHandler.handleZpidsPage(queryZpid);
            } else if (label === LABELS.QUERY || label === LABELS.SEARCH) {
                await pageHandler.handleQueryAndSearchPage(label, queryZpid);
            }

            await extendScraperFunction(undefined, {
                page,
                request,
                session,
                processZpid: pageHandler.processZpid,
                queryZpid,
                label: 'HANDLE',
            });

            if (pageHandler.foundAnyErrors()) {
                session.retire();
                throw new Error('Retiring session and browser...');
            }
        },
        handleFailedRequestFunction: async ({ request, error }) => {
            // This function is called when the crawling of a request failed too many times
            log.exception(error, `\n\nRequest ${request.url} failed too many times.\n\n`);
        },
    });

    if (!isDebug) {
        fns.patchLog(crawler);
    }
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
