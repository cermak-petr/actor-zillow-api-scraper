const Apify = require('apify');
const _ = require('lodash');
const {handleQuery} = require("./crawler/query");
const {handleSearch} = require("./crawler/query");
const {handleInitialCrawl} = require("./crawler/init");
const {RetireError, handleDetailCrawl} = require("./crawler/detail");
const {
    initProxyConfig,
    initCrawler
} = require("./crawler/init");
const {LABELS, USER_AGENT} = require('./constants');
const {
    queryRegionHomes,
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
            try {
                // Either there is no response or we have already scraped the desired product count
                if (!response || isEnoughItemsCollected(maxItems, zpids)) {
                    await page.close();
                    return;
                }

                // Retire browser if captcha is found
                if (await page.$('.captcha-container')) {
                    throw new RetireError('Captcha found, retrying...');
                }

                let anyErrors = false;
                const {label} = request.userData;
                if (label === LABELS.INITIAL || !queryZpid) {
                    // LABELS.INITIAL: Get queryZpid to be able to use zillow graphql
                    queryZpid = await handleInitialCrawl(page, requestQueue, startUrls, autoscaledPool);
                } else if (label === LABELS.DETAIL) {
                    // LABELS.DETAIL: Crawl product (home) detail page
                    if (isEnoughItemsCollected(maxItems, zpids)) {
                        return;
                    }
                    await handleDetailCrawl(page, request, requestQueue, extendOutputFunction);
                } else if (label === LABELS.ZPIDS) {
                    // LABELS.ZPIDS: Extract all home detail pages by input ZPIDs
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
                    // LABELS.QUERY and LABELS.SEARCH: Process graphql query and search
                    if (label === LABELS.SEARCH) {
                        anyErrors = await handleSearch(page, request);
                    }
                    await handleQuery(page, request, requestQueue, extendOutputFunction, input, zpids, queryZpid);
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
                    throw new RetireError('Retiring session and browser...')
                }
            } catch (e) {
                if (e instanceof RetireError) {
                    // We need to retire the session due to an successful scrape defense such as captcha
                    log.info(`Retiring browser session due to: "${e.message}"`);
                    await retire(session, browserController);
                    throw e;
                } else {
                    // Another error occurs, propagate it to the SDK
                    throw e;
                }
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
