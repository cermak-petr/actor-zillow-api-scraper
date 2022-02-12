const Apify = require('apify');
const { sleep } = require('apify/build/utils');

const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { LABELS, TYPES, RESULTS_LIMIT, PAGES_LIMIT } = require('./constants'); // eslint-disable-line no-unused-vars

const fns = require('./functions');

const {
    createQueryZpid,
    interceptQueryId,
    extractQueryStates,
    quickHash,
    splitQueryState,
} = fns;

const { log } = Apify.utils;

class PageHandler {
    /**
     *
     * @param {{
     *  page: Puppeteer.Page,
     *  request: Apify.Request,
     *  crawler: Apify.PuppeteerCrawler,
     *  session: Apify.Session,
     *  response: any,
     *  proxyInfo: Apify.ProxyInfo }} context
     * @param {{
     *  zpids: Set<any>,
     *  input: {
     *      maxItems: Number,
     *      maxLevel: Number,
     *      splitThreshold: Number,
     *      startUrls: Apify.RequestOptions[],
     *      type: keyof TYPES,
     *      handlePageTimeoutSecs: number,
     *      zpids: any[]
     *  },
     *  maxZpidsFound: Number,
     *  crawler: Apify.PuppeteerCrawler,
     * }} globalContext
     * @param {*} extendOutputFunction
     */
    constructor({ page, request, crawler, session, proxyInfo },
        { zpids, input, maxZpidsFound },
        extendOutputFunction) {
        const { requestQueue, autoscaledPool } = crawler;
        this.context = { page, request, requestQueue, autoscaledPool, session, proxyInfo };
        this.globalContext = { zpids, input, maxZpidsFound, crawler };
        this.extendOutputFunction = extendOutputFunction;

        this.anyErrors = false;

        this.dump = log.LEVELS.DEBUG === Apify.utils.log.getLevel()
            ? async (/** @type {any} */ zpid, /** @type {any} */ data) => {
                if (zpid != +zpid) {
                    await Apify.setValue(`DUMP-${Math.random()}`, data);
                }
            }
            : () => {};
    }

    /**
     *
     * @param {ReturnType<typeof createQueryZpid> | null } queryZpid
     * @param {Array<Apify.RequestOptions>} startUrls
     * @returns queryZpid
     */
    async handleInitialPage(queryZpid, startUrls) {
        const { page, proxyInfo, autoscaledPool, requestQueue, session } = this.context;
        const { input, crawler } = this.globalContext;

        try {
            log.info('Trying to get queryId...');

            const { queryId, clientVersion } = await interceptQueryId(page, proxyInfo);

            if (!queryId || !clientVersion) {
                throw new Error('queryId unavailable');
            }

            if (!queryZpid) {
                // avoid a racing condition here because of interceptQueryId being stuck forever or for a long time
                log.debug('Intercepted queryId', { queryId, clientVersion });

                queryZpid = createQueryZpid(queryId, clientVersion);

                await Apify.setValue('QUERY', { queryId, clientVersion });

                if (autoscaledPool) {
                    autoscaledPool.maxConcurrency = 10;
                }

                // now that we initialized, we can add the requests
                for (const req of startUrls) {
                    await requestQueue.addRequest(req);
                }

                log.info('Got queryId, continuing...');
            }
        } catch (e) {
            session.retire();
            throw e;
        }

        return queryZpid;
    }

    async handleDetailPage() {
        if (this.isOverItems()) {
            return;
        }

        const { request, page, requestQueue, session } = this.context;

        log.debug(`Scraping ${page.url()}`);

        if (request.url.startsWith('/b/') || !+request.userData.zpid) {
            const nextData = await page.$eval('[id="__NEXT_DATA__"]', (s) => JSON.parse(s.innerHTML));

            if (!nextData) {
                throw new Error('Missing data');
            }

            // legacy layout, need re-enqueue
            const zpid = nextData?.props?.initialData?.building?.zpid;

            if (zpid) {
                const url = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

                const rq = await requestQueue.addRequest({
                    url,
                    userData: {
                        label: LABELS.DETAIL,
                        zpid: +zpid,
                    },
                    uniqueKey: zpid || url,
                }, { forefront: true });

                if (!rq.wasAlreadyPresent) {
                    log.info(`Re-enqueueing ${url}`);
                }

                return;
            }

            request.noRetry = true;
            throw new Error('ZPID not found in page');
        }

        const scripts = await page.$x('//script[contains(., "RenderQuery") and contains(., "apiCache")]');

        // await Apify.setValue(`${request.userData.zpid}--${Math.random()}`, await page.content(), { contentType: 'text/html' });

        if (!scripts.length) {
            session.retire();
            throw new Error('Failed to load preloaded data scripts');
        }

        log.info(`Extracting data from ${request.url}`);
        let noScriptsFound = true;

        for (const script of scripts) {
            try {
                const loaded = JSON.parse(JSON.parse(await script.evaluate((/** @type {any} */ s) => s.innerHTML)).apiCache);

                for (const key in loaded) { // eslint-disable-line
                    if (key.includes('RenderQuery') && loaded[key].property) {
                        await this.extendOutputFunction(loaded[key].property, {
                            request,
                            page,
                            zpid: request.userData.zpid,
                        });

                        noScriptsFound = false;
                        break;
                    }
                }
            } catch (/** @type {any} */ e) {
                if (e.message.includes('Cannot read property')) {
                    // this is a faulty extend output function
                    log.error(`Your Extend Output Function errored:\n\n    ${e}\n\n`, { url: page.url() });
                }
                log.debug(e);
            }
        }

        if (noScriptsFound) {
            throw new Error('Failed to load preloaded data from page');
        }
    }

    /**
     *
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     */
    async handleZpidsPage(queryZpid) {
        // Extract all homes by input ZPIDs
        const { input } = this.globalContext;

        log.info(`Scraping ${input.zpids.length} zpids`);

        for (const zpid of input.zpids) {
            await this.processZpid(zpid, '', queryZpid);

            if (this.isOverItems()) {
                break;
            }
        }
    }

    /**
     *
     * @param {string} label
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     * @returns
     */
    async handleQueryAndSearchPage(label, queryZpid) {
        const { request: { userData: { term } }, session } = this.context;

        let queryStates = [];
        let totalCount = 0;
        let shouldContinue = true;

        try {
            if (label === LABELS.SEARCH) {
                log.info(`Searching for "${term}"`);
                await this._waitForSearchPageToLoad();
            }

            const pageQs = await this._getPageQs();
            const results = this.__getPageQsResults(pageQs);

            shouldContinue = await this._processPageQsResults(results, queryZpid);

            if (shouldContinue) {
                const extracted = await this._extractQueryStatesForCurrentPage(pageQs);
                queryStates = Object.values(extracted.state);
                totalCount = extracted.totalCount;
            }
        } catch (/** @type {any} */ e) {
            session.retire();
            log.debug('handleQueryAndSearchPage', { error: e.message });
        }

        log.debug('searchState', { queryStates });

        if (shouldContinue && queryStates?.length) {
            await this._processExtractedQueryStates(queryStates, totalCount, queryZpid);
        }
    }

    /**
     *
     * @param {string} zpid
     * @param {string} detailUrl
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     * @returns
     */
    async processZpid(zpid, detailUrl, queryZpid) {
        const { page, request, requestQueue, session } = this.context;
        const { zpids } = this.globalContext;

        if (this.isOverItems()) {
            return;
        }

        const invalidNonNumeric = 'Invalid non-numeric zpid';
        const notZpid = `Zpid not string or number`;

        try {
            if (!zpid) {
                throw new Error(notZpid);
            }

            if (+zpid != zpid) {
                throw new Error(invalidNonNumeric);
            }

            if (zpids.has(`${zpid}`)) {
                log.debug(`Zpids already contain zpid ${zpid}, returning from process zpid`);
                return;
            }

            if (!session.isUsable()) {
                throw new Error('Not trying to retrieve data, session is not usable anymore');
            }

            log.debug(`Extracting ${zpid}`);

            await this.extendOutputFunction(
                JSON.parse(await queryZpid(page, zpid)).data.property,
                {
                    request,
                    page,
                    zpid,
                },
            );
        } catch (e) {
            if (this.isOverItems()) {
                return;
            }

            if ([notZpid, invalidNonNumeric].includes(e.message)) {
                log.debug(`processZpid: ${e.message} - ${zpid}`);
                return;
            }

            log.debug('processZpid', { error: e });

            // add as a separate detail for retrying
            await requestQueue.addRequest({
                url: new URL(detailUrl || `/homedetails/${zpid}_zpid/`, 'https://www.zillow.com').toString(),
                userData: {
                    label: LABELS.DETAIL,
                    zpid: +zpid,
                },
                uniqueKey: zpid || detailUrl,
            }, { forefront: true });

            this.anyErrors = true;
            session.markBad();
        } finally {
            await sleep(100);
        }
    }

    isOverItems(extra = 0) {
        const { zpids, input } = this.globalContext;
        return typeof input.maxItems === 'number' && input.maxItems > 0
            ? zpids.size + extra >= input.maxItems
            : false;
    }

    foundAnyErrors() {
        return this.anyErrors;
    }

    async _waitForSearchPageToLoad() {
        const { page, request, session } = this.context;

        const text = '#search-box-input';
        const btn = 'button#search-icon';

        await page.waitForRequest((/** @type {any} */ req) => req.url().includes('/login'));

        await Promise.all([
            page.waitForSelector(text),
            page.waitForSelector(btn),
        ]);

        await page.focus(text);
        await Promise.all([
            page.waitForResponse((/** @type {any} */ res) => res.url().includes('suggestions')),
            page.type(text, request.userData.term, { delay: 150 }),
        ]);

        try {
            await Promise.all([
                page.waitForNavigation({ timeout: 10000 }),
                page.tap(btn),
            ]);
        } catch (/** @type {any} */ e) {
            log.debug(e.message);

            const interstitial = await page.$$('#interstitial-title');
            if (!interstitial.length) {
                session.retire();
                throw new Error('Search didn\'t redirect, retrying...');
            } else {
                const skip = await page.$x('//button[contains(., "Skip")]');

                try {
                    await Promise.all([
                        page.waitForNavigation({ timeout: 25000 }),
                        skip[0].click(),
                    ]);
                } catch (/** @type {any} */ er) {
                    log.debug(`Insterstitial`, { message: er.message });
                    throw new Error('Search page didn\'t redirect in time');
                }
            }
        }

        if ((!/(\/homes\/|_rb)/.test(page.url()) || page.url().includes('/_rb/') || page.url().includes('_zpid')) && !page.url().includes('searchQueryState')) {
            session.retire();
            throw new Error(`Unexpected page address ${page.url()}, use a better keyword for searching or proper state or city name. Will retry...`);
        }

        if (await page.$('.captcha-container')) {
            session.retire();
            throw new Error('Captcha found when searching, retrying...');
        }
    }

    async _getPageQs() {
        const { page } = this.context;

        return page.evaluate(() => {
            const pageQsElement = document.querySelector(
                'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
            );
            const slicedPageQs = pageQsElement ? pageQsElement.innerHTML.slice(4, -3) : '';
            return slicedPageQs ? JSON.parse(slicedPageQs) : {};
        });
    }

    /**
     *
     * @param {any} pageQs
     * @returns array of list results and map results for cat1 and cat2 merged
     */
    __getPageQsResults(pageQs) {
        return [
            ...pageQs?.cat1?.searchResults?.listResults ?? [],
            ...pageQs?.cat1?.searchResults?.mapResults ?? [],
            ...pageQs?.cat2?.searchResults?.listResults ?? [],
            ...pageQs?.cat2?.searchResults?.mapResults ?? [],
        ];
    }

    /**
     *
     * @param {any[]} results
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     * @returns result of shouldContinue
     */
    async _processPageQsResults(results, queryZpid) {
        let shouldContinue = true;

        for (const { zpid, detailUrl } of results) {
            await this.dump(zpid, results);

            if (zpid) {
                if (this.isOverItems()) {
                    shouldContinue = false;
                    break;
                }
                await this.processZpid(zpid, detailUrl, queryZpid);
            }
        }

        return shouldContinue;
    }

    /**
     *
     * @param {any} pageQs
     * @returns extracted query states with total count stored
     */
    async _extractQueryStatesForCurrentPage(pageQs) {
        const { request, page } = this.context;
        const { input } = this.globalContext;

        const pageNumber = request.userData.pageNumber ? request.userData.pageNumber : 1;

        const extractedQueryStates = await extractQueryStates(request, input.type, page, pageQs, pageNumber);
        const states = Object.values(extractedQueryStates);
        const totalCount = states.reduce((out, { totalCount }) => (out + totalCount), 0);

        this.globalContext.maxZpidsFound = Math.max(totalCount, this.globalContext.maxZpidsFound);

        if (totalCount > 0) {
            log.info(`Found ${totalCount} results on page ${pageNumber}.`);
        }

        return {
            state: states.map(({ state }) => state),
            totalCount,
        };
    }

    /**
     *
     * @param {any[]} queryStates
     * @param {Number} totalCount
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     * @returns
     */
    async _processExtractedQueryStates(queryStates, totalCount, queryZpid) {
        const { page, request: { uniqueKey, userData: { pageNumber } } } = this.context;
        const { zpids } = this.globalContext;
        const currentPage = pageNumber || 1;

        const results = this._mergeListResultsMapResults(queryStates);
        const result = await this._validateQueryStatesResults(results, queryStates, totalCount);

        if (result === false) {
            return;
        }

        for (const { qs } of queryStates) {
            if (zpids.size >= this.globalContext.maxZpidsFound) {
                return; // all results extracted already, performance optimization
            }

            log.info(`Searching homes at ${JSON.stringify(qs.mapBounds)}`, {
                url: page.url(),
            });

            if (currentPage === 1) {
                await this._tryEnqueueMapSplits(qs, totalCount);
                await this._tryEnqueuePaginationPages(qs, totalCount);
            }

            await this._extractZpidsFromResults(results, queryZpid);
        }

        if (log.LEVELS.DEBUG === log.getLevel()) {
            await Apify.setValue(`QUERY-STATES-${uniqueKey}`, queryStates);
        }
    }

    /**
     *
     * @param {any[]} queryStates
     * @returns merged list results and map results
     */
    _mergeListResultsMapResults(queryStates) {
        return queryStates.flatMap(({ searchState }) => [
            ...searchState?.cat1?.searchResults?.mapResults ?? [],
            ...searchState?.cat1?.searchResults?.listResults ?? [],
            ...searchState?.cat2?.searchResults?.mapResults ?? [],
            ...searchState?.cat2?.searchResults?.listResults ?? [],
        ]).flat(2);
    }

    /**
     * Retires session and throws error if no results were found
     * @param {any[]} results
     * @param {any[]} queryStates
     * @param {Number} totalCount
     */
    async _validateQueryStatesResults(results, queryStates, totalCount) {
        const { session } = this.context;

        if (!results?.length) {
            if (totalCount > 0) {
                log.debug(`No results, retiring session.`);
                session.retire();
                await Apify.setValue(`SEARCHSTATE-${Math.random()}`, queryStates);
                throw new Error(`No map results but result count is ${totalCount}`);
            } else {
                log.debug('Really zero results');
                return false;
            }
        }
    }

    /**
     *
     * @param {{
     *   mapBounds: {
     *   mapZoom: Number,
     *   south: Number,
     *   east: Number,
     *   north: Number,
     *   west: Number,
     * }}} queryState,
     * @param {Number} totalCount
     */
    async _tryEnqueueMapSplits(queryState, totalCount) {
        const { request } = this.context;
        const { input } = this.globalContext;

        const mapSplittingThreshold = input.splitThreshold || RESULTS_LIMIT;

        if (totalCount >= mapSplittingThreshold) {
            const currentSplitCount = request.userData.splitCount ?? 0;
            const maxLevel = input.maxLevel ?? 5;

            if (currentSplitCount >= maxLevel) {
                log.info('Over max level');
            } else {
                // Split map and enqueue sub-rectangles
                const splits = splitQueryState(queryState);
                log.info(`Splitting map into ${splits.length} squares and zooming in`);
                const splitCount = currentSplitCount + 1;
                await this._enqueueMapSplits(splits, splitCount);
            }
        }
    }

    /**
     * Zillow doesn't always provide all map results from the current page,
     * even if their count is < RESULTS_LIMIT. E.g. for 115 map results it only gives 84.
     * But they can still be extracted from list results using pagination search.
     * @param {any} searchQueryState
     * @param {Number} totalCount
     */
    async _tryEnqueuePaginationPages(searchQueryState, totalCount) {
        const { requestQueue, request } = this.context;
        const { zpids } = this.globalContext;

        if (totalCount > 0 && zpids.size < this.globalContext.maxZpidsFound) {
            log.info(`Found ${totalCount} results, pagination pages will be enqueued.`);
            const LISTINGS_PER_PAGE = 40;

            // first pagination page is already fetched successfully, pages are ordered from 1 (not from 0)
            const pagesCount = Math.min((totalCount / LISTINGS_PER_PAGE) + 1, PAGES_LIMIT);

            const url = new URL(request.url);
            url.pathname = url.pathname === '/' ? '/homes/' : url.pathname;

            for (let i = 2; i <= pagesCount; i++) {
                url.searchParams.set('searchQueryState', JSON.stringify({
                    ...searchQueryState,
                    pagination: {
                        currentPage: i,
                    },
                }));

                const uniqueKey = quickHash(`${JSON.stringify(searchQueryState)}`);

                log.debug(`Enqueuing pagination page number ${i} for url: ${url.toString()}`);
                await requestQueue.addRequest({
                    url: url.toString(),
                    userData: {
                        searchQueryState,
                        label: LABELS.QUERY,
                        pageNumber: i,
                    },
                    uniqueKey,
                });
            }
        }
    }

    /**
     *
     * @param {any[]} splits
     * @param {Number} splitCount
     */
    async _enqueueMapSplits(splits, splitCount) {
        const { request, requestQueue } = this.context;

        for (const searchQueryState of splits) {
            if (this.isOverItems()) {
                break;
            }

            const uniqueKey = quickHash(`${JSON.stringify(searchQueryState)}`);
            log.debug('queryState', { searchQueryState, uniqueKey });
            const url = new URL(request.url);
            url.pathname = url.pathname === '/' ? '/homes/' : url.pathname;
            url.searchParams.set('searchQueryState', JSON.stringify(searchQueryState));
            url.searchParams.set('pagination', '{}');

            log.debug(`Enqueuing map split request: ${url.toString()}`);

            await requestQueue.addRequest({
                url: url.toString(),
                userData: {
                    searchQueryState,
                    label: LABELS.QUERY,
                    splitCount,
                },
                uniqueKey,
            });
        }
    }

    /**
     * Extracts zpids from results, processes zpids and sets extraction info interval
     * @param {any[]} results
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     */
    async _extractZpidsFromResults(results, queryZpid) {
        const { zpids } = this.globalContext;

        if (results.length > 0) {
            let lastCount = 0;
            const extracted = () => {
                if (zpids.size !== lastCount) {
                    lastCount = zpids.size;
                    log.info(`Extracted total ${zpids.size}`);
                }
            };
            const interval = setInterval(extracted, 10000);

            try {
                for (const { zpid, detailUrl } of results) {
                    await this.dump(zpid, results);

                    if (zpid) {
                        await this.processZpid(zpid, detailUrl, queryZpid);

                        if (this.isOverItems()) {
                            break; // optimize runtime
                        }
                    }
                }
            } finally {
                if (!this.anyErrors) {
                    extracted();
                }
                clearInterval(interval);
            }
        }
    }
}

module.exports = {
    PageHandler,
};
