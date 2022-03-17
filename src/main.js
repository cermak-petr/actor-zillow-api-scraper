const Apify = require('apify');
const { LABELS, INITIAL_URL, URL_PATTERNS_TO_BLOCK } = require('./constants');
const { PageHandler } = require('./page-handler');
const {
    getExtendOutputFunction,
    getSimpleResultFunction,
    validateInput,
    getInitializedStartUrls,
    initializePreLaunchHooks,
} = require('./initialization');
const fns = require('./functions');

const {
    createQueryZpid,
    proxyConfiguration,
    getUrlData,
    extendFunction,
    minMaxDates,
} = fns;

const { log, puppeteer } = Apify.utils;

Apify.main(async () => {
    /**
     * @type {any}
     */
    const input = await Apify.getInput();

    if (input.debugLog) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    const isDebug = input.debugLog === true;

    validateInput(input);

    const proxyConfig = await proxyConfiguration({
        proxyConfig: {
            ...input.proxyConfiguration,
        },
    });

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = 'US';
    }

    const minMaxDate = minMaxDates(input);

    const getSimpleResult = getSimpleResultFunction(input);

    /** @type {any} */
    const zpidsValues = await Apify.getValue('STATE');
    const zpids = new Set(zpidsValues);

    /**
     * @type {{
     *   zpids: Set<string>,
     *   input: PageHandler['globalContext']['input'],
     *   crawler: Apify.PuppeteerCrawler,
     * }}
     */
    const globalContext = {
        zpids,
        input,
    };

    const persistState = async () => {
        await Apify.setValue('STATE', [...zpids.values()]);
    };

    Apify.events.on('aborting', persistState);
    Apify.events.on('migrating', persistState);

    const requestQueue = await Apify.openRequestQueue();
    const loadQueue = getInitializedStartUrls(input, requestQueue);

    /**
     * @type {ReturnType<typeof createQueryZpid> | null}
     */
    let queryZpid = null;

    /**
     * @type {any}
     */
    const savedQueryId = await Apify.getValue('QUERY');

    if (savedQueryId?.queryId && savedQueryId?.clientVersion) {
        queryZpid = createQueryZpid(savedQueryId.queryId, savedQueryId.clientVersion);

        await loadQueue();
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
        ? (globalContext.zpids.size + extra) >= input.maxItems
        : false);

    const extendOutputFunction = await getExtendOutputFunction(globalContext, minMaxDate, getSimpleResult);

    const extendScraperFunction = await extendFunction({
        output: async () => {}, // no-op
        input,
        key: 'extendScraperFunction',
        helpers: {
            proxyConfig,
            getUrlData,
            requestQueue,
            get queryZpid() {
                // if we use the variable here won't change to the actual function
                // and will always get null
                return queryZpid;
            },
            getSimpleResult,
            zpids: globalContext.zpids,
            fns,
            extendOutputFunction,
            minMaxDate,
        },
    });

    await extendScraperFunction(undefined, {
        label: 'SETUP',
    });

    let isFinishing = false;

    /**
     * browserPool is initialized separately before crawler's initialization because
     * preLaunchHooks and postPageCloseHooks are not recognized as valid properties
     * of browserPoolOptions inside PuppeteerCrawler's constructor (whole blocks
     * of preLaunchHooks and postPageCloseHooks are marked as warnings by tslint).
     */

    /**
     * crawlerWrapper is used because preLaunchHooks initialization requires
     * crawler instance which hasn't yet been initialized
     * @type {{ crawler: Apify.PuppeteerCrawler | null }}
     */
    const crawlerWrapper = { crawler: null };

    /**
     * @type {Apify.BrowserCrawlerOptions['browserPoolOptions']}
     */
    const browserPoolOptions = {
        useFingerprints: true,
        preLaunchHooks: initializePreLaunchHooks(input),
        fingerprintsOptions: {
            fingerprintGeneratorOptions: {
                browsers: ['chrome'],
                devices: ['desktop'],
                locales: ['en-US', 'en'],
            },
        },
        maxOpenPagesPerBrowser: 1,
        retireBrowserAfterPageCount: 1,
        prePageCloseHooks: [async (page, browserController) => {
            const { request } = crawler.crawlingContexts.get(browserController.launchContext.id);

            if (request?.errorMessages?.some((error) => error.includes('ERR_TOO_MANY_REDIRECTS'))) {
                request.noRetry = true;
            }
        }],
    };

    // Create crawler
    crawlerWrapper.crawler = new Apify.PuppeteerCrawler({
        requestQueue,
        maxRequestRetries: input.maxRetries || 5,
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
        launchContext: {
            useIncognitoPages: true,
        },
        preNavigationHooks: [async ({ request, page }, gotoOptions) => {
            if (isFinishing) {
                // avoid browser-pool errors with Target closed.
                request.noRetry = true;
                throw new Error('Ending scrape');
            }

            /** @type {any} */
            await puppeteer.blockRequests(page, {
                urlPatterns: URL_PATTERNS_TO_BLOCK.concat([
                    LABELS.DETAIL,
                    LABELS.ZPIDS,
                    LABELS.ENRICHED_ZPIDS,
                ].includes(request.userData.label) ? [
                        'maps.googleapis.com',
                        '.js',
                    ] : []),
            });

            await extendScraperFunction(undefined, {
                page,
                request,
                label: 'GOTO',
            });

            gotoOptions.timeout = 45000;
            gotoOptions.waitUntil = 'domcontentloaded';
        }],
        persistCookiesPerSession: false,
        postNavigationHooks: [async ({ page }) => {
            try {
                if (!page.isClosed()) {
                    await page.bringToFront();
                }
            } catch (e) {}

            if (isOverItems() && !isFinishing) {
                isFinishing = true;
                try {
                    log.info('Reached maximum items, waiting for finish');
                    if (crawlerWrapper?.crawler?.autoscaledPool) {
                        await Promise.all([
                            crawlerWrapper.crawler.autoscaledPool.pause(),
                            // @ts-ignore
                            crawlerWrapper.crawler.autoscaledPool.resolve(),
                        ]);
                    }
                } catch (e) {}
            }
        }],
        browserPoolOptions,
        maxConcurrency: !queryZpid ? 1 : 10,
        handlePageFunction: async (context) => {
            const { page, request, session, response } = context;
            const pageHandler = new PageHandler(context, globalContext, extendOutputFunction);

            if (!response || pageHandler.isOverItems()) {
                if (!response) {
                    throw new Error('No response from page');
                }
                return;
            }

            await pageHandler.checkForCaptcha();

            const { label } = request.userData;

            if (label === LABELS.INITIAL || !queryZpid) {
                queryZpid = await pageHandler.handleInitialPage(queryZpid, loadQueue);
            } else if (label === LABELS.DETAIL) {
                await pageHandler.handleDetailPage();
            } else if (label === LABELS.ZPIDS || label === LABELS.ENRICHED_ZPIDS) {
                await pageHandler.handleZpidsPage(queryZpid);
            } else if (label === LABELS.QUERY || label === LABELS.SEARCH) {
                await pageHandler.handleQueryAndSearchPage(label);
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
            if (request.retryCount) {
                log.error(request.noRetry ? 'Stopped retrying request' : `${request.url} failed too many times`, { error: error.message });
            }
        },
    });

    const { crawler } = crawlerWrapper;
    globalContext.crawler = crawler;

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

    log.info(`Done with ${globalContext.zpids.size} listings!`);
});
