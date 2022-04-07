const Apify = require('apify');

/* eslint-disable no-unused-vars */
const Puppeteer = require('puppeteer');
const {
    LABELS,
    TYPES,
    PAGES_LIMIT,
    SearchQueryState,
    GetSearchPageState,
    ZpidResult,
    ORIGIN,
} = require('./constants');
/* eslint-enable no-unused-vars */

const fns = require('./functions');

const {
    createQueryZpid,
    interceptQueryId,
    extractQueryStates,
    splitQueryState,
} = fns;

const { log, sleep } = Apify.utils;

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
     *  zpidsHandler: fns.ZpidHandler,
     *  input: {
     *      maxItems: number,
     *      maxLevel: number,
     *      debugLog: boolean,
     *      splitThreshold: number,
     *      startUrls: Apify.RequestOptions[],
     *      type: keyof TYPES,
     *      handlePageTimeoutSecs: number,
     *      includeRelaxedResults: boolean,
     *      zpids: any[],
     *  },
     *  crawler: Apify.PuppeteerCrawler,
     * }} globalContext
     * @param {*} extendOutputFunction
     */
    constructor({ page, request, crawler, session, proxyInfo }, { zpidsHandler, input }, extendOutputFunction) {
        const { requestQueue, autoscaledPool } = crawler;

        this.context = { page, request, requestQueue, autoscaledPool, session, proxyInfo };
        this.globalContext = { zpidsHandler, input, crawler };
        this.extendOutputFunction = extendOutputFunction;

        this.anyErrors = false;

        this.pendingPromise = this.getResponse(page);
    }

    /**
     * This promise is needed as a fallback from the page load state that contains no results,
     * but a request is issued to this endpoint. Needs to start waiting before anything else
     *
     * @param {Puppeteer.Page} page
     * @returns {Promise<{ result: GetSearchPageState, searchQueryState: SearchQueryState } | null>}
     */
    async getResponse(page) {
        try {
            const response = await page.waitForResponse((req) => {
                return req.url().includes('/search/GetSearchPageState.htm');
            }, { timeout: 45000 });

            const searchQueryState = new URL(response.request().url()).searchParams.get('searchQueryState');

            return {
                result: await response.json(),
                searchQueryState: JSON.parse(searchQueryState ?? '{}'),
            };
        } catch (e) {
            log.debug('getResponse', { e: e.message });

            return null;
        }
    }

    /**
     * @param {ReturnType<typeof createQueryZpid> | null} queryZpid
     * @param {() => Promise<void>} loadQueue
     * @returns {Promise<queryZpid>}
     */
    async handleInitialPage(queryZpid, loadQueue) {
        const { crawler, input } = this.globalContext;
        const { page, proxyInfo, autoscaledPool, session } = this.context;

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

                log.info('Got queryId, continuing...');
            }
        } catch (e) {
            session.retire();
            throw e;
        }

        fns.changeHandlePageTimeout(crawler, input.handlePageTimeoutSecs || 3600);

        await loadQueue();

        return queryZpid;
    }

    async handleDetailPage() {
        const { isOverItems } = this.globalContext.zpidsHandler;

        if (isOverItems()) {
            return;
        }

        const { request, page, requestQueue, session } = this.context;

        const url = page.url();
        log.debug(`Scraping ${url}`);

        if (url.includes('/b/') || !+request.userData.zpid) {
            const nextData = await page.$eval('[id="__NEXT_DATA__"]', (s) => JSON.parse(s.innerHTML));

            if (!nextData) {
                throw new Error('Missing data');
            }

            // legacy layout, need re-enqueue
            const zpid = fns.normalizeZpid(nextData?.props?.initialData?.building?.zpid);

            if (zpid) {
                const zpidUrl = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

                const rq = await requestQueue.addRequest({
                    url: zpidUrl,
                    userData: {
                        label: LABELS.DETAIL,
                        zpid,
                    },
                    uniqueKey: zpid || zpidUrl,
                });

                if (!rq.wasAlreadyPresent) {
                    log.info(`Re-enqueueing ${zpidUrl}`);
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

        let noScriptsFound = true;

        for (const script of scripts) {
            try {
                const loaded = JSON.parse(JSON.parse(await script.evaluate((/** @type {any} */ s) => s.innerHTML)).apiCache);

                for (const key in loaded) { // eslint-disable-line
                    if (key.includes('FullRenderQuery') && loaded[key].property) {
                        log.info(`Extracting data from ${url}`);

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
                if (/(Reference|Type|Syntax)Error/.test(e.message)) {
                    // this is a faulty extend output function
                    log.error(`Your Extend Output Function errored:\n\n    ${e.message}\n\n`, { url: page.url() });
                }
                log.debug(e);
            }
        }

        if (noScriptsFound) {
            throw new Error('Failed to load preloaded data from page');
        }
    }

    /**
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     */
    async handleZpidsPage(queryZpid) {
        const { request } = this.context;
        const { zpids } = request.userData;

        if (!zpids?.length) {
            log.debug('zpids userData is empty');
            return;
        }

        return this._extractZpidsFromResults(zpids, queryZpid);
    }

    /**
     * @param {ZpidResult[]} zpids
     * @param {string} url
     * @param {string} hash
     */
    async _addZpidsRequest(zpids, url, hash) {
        const { isOverItems } = this.globalContext.zpidsHandler;
        const { requestQueue } = this.context;

        if (isOverItems()) {
            return;
        }

        if (!zpids.length) {
            return;
        }

        return requestQueue?.addRequest({
            url,
            uniqueKey: fns.quickHash(['ZPIDS', hash]),
            userData: {
                label: LABELS.ENRICHED_ZPIDS,
                zpids,
            },
        }, { forefront: true });
    }

    /**
     *
     * @param {string} label
     */
    async handleQueryAndSearchPage(label) {
        const { request, session, page } = this.context;

        try {
            if (label === LABELS.SEARCH) {
                const { term } = request.userData;
                log.info(`Searching for "${term}"`);
                await this._waitForSearchPageToLoad();
            }

            const [pageQs, loadedQs] = await Promise.all([
                this._getPageQs(),
                this.pendingPromise,
            ]);

            const merged = this._getMergedSearchResults([
                loadedQs?.result,
                pageQs,
            ]);

            const containsResults = this._validateQueryStatesResults(merged.results, merged.categoryTotals);

            if (!containsResults) {
                // this silently finishes when there's really no results
                // when it's an error, this check won't be reached
                log.debug(`!containsResults`, merged);
                return;
            }

            // the loaded queryState is usually better than the one from page load
            const queryState = loadedQs?.searchQueryState
                ?? pageQs.queryState;

            await this._addZpidsRequest(
                merged.results,
                page.url(),
                fns.getUniqueKeyFromQueryState(queryState),
            );

            log.info(`[${merged.title}]: ${merged.results.length}/${merged.categoryTotals} (this number is an approximation)`);

            if (!merged.zeroResultsFilter && (merged.categoryTotals + merged.results.length) >= 500) {
                await Promise.allSettled([
                    this._tryEnqueueMapSplits(queryState),
                    this._tryEnqueuePaginationPages(queryState),
                ]);
            }

            await this._extractQueryStatesForCurrentPage(queryState);
        } catch (/** @type {any} */ e) {
            session.retire();
            log.debug('handleQueryAndSearchPage', { error: e.message });

            if (label === LABELS.SEARCH) {
                throw new Error('Retrying search');
            }

            if (e.message.includes('Unexpected')) {
                throw new Error('Request blocked, retrying...');
            }

            throw e;
        }
    }

    /**
     *
     * @param {string | null | undefined} zpid
     * @param {string} detailUrl
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     * @param {boolean} relaxed Relaxed results are incomplete, so needs full page load
     */
    async processZpid(zpid, detailUrl, queryZpid, relaxed = false) {
        const { page, request, requestQueue, session } = this.context;
        const { isOverItems, has } = this.globalContext.zpidsHandler;

        if (isOverItems()) {
            return;
        }

        const normalizedZpid = fns.normalizeZpid(zpid);

        const enqueueZpid = () => requestQueue.addRequest({
            url: new URL(detailUrl || `/homedetails/${normalizedZpid}_zpid/`, ORIGIN).toString(),
            userData: {
                label: LABELS.DETAIL,
                zpid: normalizedZpid,
            },
            uniqueKey: normalizedZpid || detailUrl,
        }, { forefront: true });

        if (relaxed) {
            log.debug('Enqueuing relaxed zpid', { zpid });
            return enqueueZpid();
        }

        const invalidNonNumeric = 'Invalid non-numeric zpid';
        const notZpid = `Zpid not string or number`;
        let noWait = false;

        try {
            if (!normalizedZpid) {
                noWait = true;
                log.debug('Invalid zpid', { zpid });
                return;
            }

            if (has(normalizedZpid)) {
                noWait = true;
                log.debug(`Zpids already contain zpid ${normalizedZpid}, going for next parse`);
                return;
            }

            if (!session.isUsable()) {
                throw new Error('Not trying to retrieve data, session is not usable anymore');
            }

            log.debug(`Extracting ${normalizedZpid}`);

            await this.extendOutputFunction(
                JSON.parse(await queryZpid(page, normalizedZpid)).data.property,
                {
                    request,
                    page,
                    zpid: normalizedZpid,
                },
            );
        } catch (e) {
            if (isOverItems()) {
                return;
            }

            if ([notZpid, invalidNonNumeric].includes(e.message)) {
                noWait = true;
                log.debug(`processZpid: ${e.message} - ${zpid}`);
                return;
            }

            log.debug('processZpid', { error: e.message });

            // add as a separate detail for retrying
            await enqueueZpid();

            this.anyErrors = true;
            session.retire();
        } finally {
            if (!noWait) {
                await sleep(100);
            }
        }
    }

    foundAnyErrors() {
        return this.anyErrors;
    }

    async _waitForSearchPageToLoad() {
        const { page, request, session } = this.context;

        const text = '#search-box-input';
        const btn = 'button#search-icon';

        await page.waitForRequest((req) => req.url().includes('/login'));

        await Promise.all([
            page.waitForSelector(text),
            page.waitForSelector(btn),
        ]);

        await page.focus(text);
        await Promise.all([
            page.waitForResponse((res) => res.url().includes('suggestions')),
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

        await this.checkForCaptcha();
    }

    async checkForCaptcha() {
        const { page, session } = this.context;

        if (await page.$('.captcha-container')) {
            session.retire();
            throw new Error('Captcha found when searching, retrying...');
        }
    }

    /**
     * @returns {Promise<{ queryState: SearchQueryState } & GetSearchPageState>}
     */
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
     * Objects come from GetSearchPageState.htm call
     *
     * @param {Array<GetSearchPageState | undefined>} pageQs
     * @returns array of list results and map results for cat1 and cat2 merged
     */
    _getMergedSearchResults(pageQs) {
        const { zpidsHandler: { has }, input: { includeRelaxedResults = true } } = this.globalContext;
        const set = new Set();
        /** @type {Array<ZpidResult>} */
        const results = [];

        return pageQs.reduce((out, qs) => {
            [
                ...qs?.cat1?.searchResults?.listResults ?? [],
                ...qs?.cat1?.searchResults?.mapResults ?? [],
                ...qs?.cat2?.searchResults?.listResults ?? [],
                ...qs?.cat2?.searchResults?.mapResults ?? [],
            ].concat(
                includeRelaxedResults ? [
                    ...(qs?.cat1?.searchResults?.relaxedResults ?? []),
                    ...(qs?.cat2?.searchResults?.relaxedResults ?? []),
                ] : [],
            )
                .map(({ zpid, detailUrl, relaxed }) => ({
                    zpid,
                    detailUrl: detailUrl || '',
                    relaxed: relaxed || false,
                }))
                .filter((s) => {
                    return !has(s.zpid);
                })
                .forEach((item) => {
                    set.add(`${item.zpid}`);
                    out.results.push(item);
                });

            out.categoryTotals = Math.max(
                out.categoryTotals,
                qs?.categoryTotals?.cat1?.totalResultCount ?? 0,
                qs?.categoryTotals?.cat2?.totalResultCount ?? 0,
            );

            out.title = qs?.cat1?.searchList?.listResultsTitle
                || qs?.cat2?.searchList?.listResultsTitle
                || out.title;

            out.zeroResultsFilter = Math.max(
                Object.keys(qs?.cat1?.searchList?.zeroResultsFilters ?? {}).length,
                Object.keys(qs?.cat2?.searchList?.zeroResultsFilters ?? {}).length,
            ) > 0;

            return out;
        }, {
            results,
            categoryTotals: -Infinity,
            title: '',
            zeroResultsFilter: false,
        });
    }

    /**
     * Enqueues all the possible combinations for extracting.
     * Uses a callback to not lose progress if any of the requests
     * fail.
     *
     * @param {SearchQueryState} pageQs
     */
    async _extractQueryStatesForCurrentPage(pageQs) {
        const { request, page } = this.context;
        const { input } = this.globalContext;
        const { pageNumber = 1, ignoreFilter } = request.userData;

        const inputType = ignoreFilter ? 'qs' : input.type;

        return extractQueryStates(
            inputType,
            page,
            pageQs,
            async ({ url, result, hash }) => {
                const { categoryTotals, results } = this._getMergedSearchResults([result]);

                if (categoryTotals > 0 || results.length) {
                    await this._addZpidsRequest(results, url, hash);
                }
            },
            pageNumber,
        );
    }

    /**
     * Retires session and throws error if no results were found
     * @param {any[]} results
     * @param {Number} totalCount
     */
    _validateQueryStatesResults(results, totalCount) {
        const { session } = this.context;

        if (!(results?.length)) {
            if (totalCount > 0) {
                log.debug(`No results, retiring session.`);
                session.retire();

                throw new Error(`No map results but result count is ${totalCount}`);
            } else {
                log.debug('Really zero results', { totalCount });
                return false;
            }
        }

        return true;
    }

    /**
     * This takes a LOT of time, but can get thousands of results
     *
     * @param {SearchQueryState} queryState
     */
    async _tryEnqueueMapSplits(queryState) {
        const { request } = this.context;
        const { input, zpidsHandler: { isOverItems } } = this.globalContext;

        const maxLevel = input.maxLevel ?? 0;

        if (isOverItems() || maxLevel === 0) {
            log.debug('Not trying to enqueue map splits', queryState);
            return;
        }

        const currentSplitCount = request.userData.splitCount ?? 0;

        if (currentSplitCount >= maxLevel) {
            log.info('Over max level, no map split will take place', { currentSplitCount, maxLevel });
        } else {
            const splits = splitQueryState(queryState);
            const splitCount = currentSplitCount + 1;
            log.info(`Splitting map into ${splits.length} squares and zooming in, ${currentSplitCount} splits done so far`);
            await this._enqueueMapSplits(splits, splitCount);
        }
    }

    /**
     * Zillow doesn't always provide all map results from the current page,
     * even if their count is < RESULTS_LIMIT. E.g. for 115 map results it only gives 84.
     * But they can still be extracted from list results using pagination search.
     *
     * @param {SearchQueryState} searchQueryState
     */
    async _tryEnqueuePaginationPages(searchQueryState) {
        const { requestQueue, page, request } = this.context;
        const { ignoreFilter, pageNumber } = request.userData;
        const { isOverItems } = this.globalContext.zpidsHandler;

        if (isOverItems() || +pageNumber) {
            log.debug('Skipping pages', searchQueryState);
            return;
        }

        const url = new URL(page.url());
        url.pathname = url.pathname === '/' ? '/homes/' : url.pathname;

        for (let i = 2; i <= 20; i++) {
            /** @type {SearchQueryState} */
            const queryState = {
                ...searchQueryState,
                pagination: {
                    currentPage: i,
                },
            };

            url.searchParams.set('searchQueryState', JSON.stringify(queryState));

            const uniqueKey = fns.getUniqueKeyFromQueryState(queryState);

            log.debug(`Enqueuing pagination page number ${i} for url: ${url.toString()}`, { uniqueKey });

            await requestQueue.addRequest({
                url: url.toString(),
                userData: {
                    label: LABELS.QUERY,
                    ignoreFilter,
                    pageNumber: i,
                },
                uniqueKey,
            });
        }
    }

    /**
     *
     * @param {SearchQueryState[]} splits
     * @param {number} splitCount
     */
    async _enqueueMapSplits(splits, splitCount) {
        const { requestQueue, page, request } = this.context;
        const { ignoreFilter } = request.userData;
        const { isOverItems } = this.globalContext.zpidsHandler;

        for (const searchQueryState of splits) {
            if (isOverItems()) {
                break;
            }

            const url = new URL(page.url());

            /** @type {SearchQueryState} */
            const queryState = {
                ...searchQueryState,
                pagination: {},
            };

            const uniqueKey = fns.getUniqueKeyFromQueryState(queryState);
            log.debug('queryState', { searchQueryState, uniqueKey });

            url.pathname = url.pathname === '/' ? '/homes/' : url.pathname;

            url.searchParams.set('searchQueryState', JSON.stringify(queryState));

            const result = await requestQueue.addRequest({
                url: url.toString(),
                userData: {
                    searchQueryState,
                    label: LABELS.QUERY,
                    splitCount,
                    ignoreFilter,
                },
                uniqueKey,
            });

            log.debug(`${result.wasAlreadyPresent ? `Didn't enqueue` : 'Enqueued'} map split request`, { url: url.toString() });
        }
    }

    startCounter() {
        const { zpidsHandler } = this.globalContext;

        let lastCount = 0;

        const extracted = () => {
            if (zpidsHandler.count !== lastCount) {
                lastCount = zpidsHandler.count;
                log.info(`Extracted total ${lastCount}`);
            }
        };

        const interval = setInterval(extracted, 10000);

        return () => {
            clearInterval(interval);

            if (!this.anyErrors) {
                extracted();
            }
        };
    }

    /**
     * Extracts zpids from results, processes zpids and sets extraction info interval
     *
     * @param {Array<ZpidResult | string>} results
     * @param {ReturnType<typeof createQueryZpid>} queryZpid
     */
    async _extractZpidsFromResults(results, queryZpid) {
        const { isOverItems } = this.globalContext.zpidsHandler;

        if (isOverItems()) {
            return;
        }

        if (results.length > 0) {
            const stop = this.startCounter();

            try {
                for (const result of results) {
                    const { zpid, detailUrl = '', relaxed = false } = typeof result === 'string'
                        ? { zpid: result } // plain string array
                        : result;

                    if (zpid) {
                        await this.processZpid(zpid, detailUrl, queryZpid, relaxed);

                        if (isOverItems()) {
                            break; // optimize runtime
                        }
                    }
                }
            } finally {
                stop();
            }
        }
    }
}

module.exports = {
    PageHandler,
};
