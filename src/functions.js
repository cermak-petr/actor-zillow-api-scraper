const Apify = require('apify');
const moment = require('moment');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { createHash } = require('crypto');
const vm = require('vm');
const { LABELS, TYPES } = require('./constants'); // eslint-disable-line no-unused-vars

const { log, requestAsBrowser } = Apify.utils;

const mappings = {
    att: 'keywords',
    schp: 'isPublicSchool',
    cityv: 'isCityView',
    wat: 'isWaterfront',
    con: 'isCondo',
    mouv: 'isMountainView',
    sto: 'singleStory',
    parka: 'onlyRentalParkingAvailable',
    mp: 'monthlyPayment',
    undefined: 'baths',
    app: 'onlyRentalAcceptsApplications',
    seo: 'SEOTypedIdField',
    zo: 'isZillowOwnedOnly',
    fr: 'isForRent',
    fsbo: 'isForSaleByOwner',
    ac: 'hasAirConditioning',
    apa: 'isApartment',
    sort: 'sortSelection',
    schm: 'isMiddleSchool',
    watv: 'isWaterView',
    schr: 'isPrivateSchool',
    inc: 'onlyRentalIncomeRestricted',
    manu: 'isManufactured',
    lau: 'onlyRentalInUnitLaundry',
    cmsn: 'isComingSoon',
    sf: 'isSingleFamily',
    fore: 'isForSaleForeclosure',
    schh: 'isHighSchool',
    ah: 'isAllHomes',
    cat: 'onlyRentalCatsAllowed',
    schc: 'isCharterSchool',
    pet: 'onlyRentalPetsAllowed',
    auc: 'isAuction',
    '3d': 'is3dHome',
    mf: 'isMultiFamily',
    nc: 'isNewConstruction',
    tow: 'isTownhouse',
    land: 'isLotLand',
    basu: 'isBasementUnfinished',
    open: 'isOpenHousesOnly',
    basf: 'isBasementFinished',
    dsrc: 'dataSourceSelection',
    pmf: 'isPreMarketForeclosure',
    fsba: 'isForSaleByAgent',
    parks: 'parkingSpots',
    pf: 'isPreMarketPreForeclosure',
    gar: 'hasGarage',
    pool: 'hasPool',
    sdog: 'onlyRentalSmallDogsAllowed',
    abo: 'isAcceptingBackupOffersSelected',
    ldog: 'onlyRentalLargeDogsAllowed',
    lot: 'lotSize',
    schb: 'greatSchoolsRating',
    schu: 'includeUnratedSchools',
    rs: 'isRecentlySold',
    pnd: 'isPendingListingsSelected',
    hc: 'onlyRentalHousingConnector',
    fmfb: 'onlyRentalFeaturedMultiFamilyBuilding',
    apco: 'isApartmentOrCondo',
    nohoa: 'includeHomesWithNoHoaData',
    sche: 'isElementarySchool',
    parkv: 'isParkView',
    sch: 'enableSchools',
};

/**
 * Transforms searchQueryState URL parameters into filters
 * MUTATES the qs filterState
 *
 * @param {{ filterState: Record<string, any> }} qs
 */
const translateQsToFilter = (qs) => {
    if (!qs) {
        return { filterState: {} };
    }

    qs.filterState = Object.entries(qs.filterState).reduce((out, [key, value]) => {
        out[mappings[key] ?? key] = value;
        return out;
    }, {});

    return qs;
};

/**
 * @param {Record<string,any>} input
 */
const makeInputBackwardsCompatible = (input) => {
    if (input && input.extendOutputFunction === '(data) => {\n    return {};\n}') {
        input.extendOutputFunction = '';
    }
};

const deferred = () => {
    let isResolved = false;
    /** @type {(res?: any) => void} */
    let resolve = () => {};
    /** @type {(err: Error) => void} */
    let reject = () => {};

    const promise = new Promise((r1, r2) => {
        resolve = (res) => {
            if (!isResolved) {
                isResolved = true;
                setTimeout(() => {
                    r1(res);
                });
            }
        };
        reject = (err) => {
            if (!isResolved) {
                isResolved = true;
                setTimeout(() => {
                    r2(err);
                });
            }
        };
    });

    return {
        resolve,
        reject,
        get isResolved() {
            return isResolved;
        },
        promise,
    };
};

/**
 * Do a generic check when using Apify Proxy
 *
 * @typedef params
 * @property {any} [params.proxyConfig] Provided apify proxy configuration
 * @property {boolean} [params.required] Make the proxy usage required when running on the platform
 * @property {string[]} [params.blacklist] Blacklist of proxy groups, by default it's ['GOOGLE_SERP']
 * @property {boolean} [params.force] By default, it only do the checks on the platform. Force checking regardless where it's running
 * @property {string[]} [params.hint] Hint specific proxy groups that should be used, like SHADER or RESIDENTIAL
 *
 * @param {params} params
 * @returns {Promise<Apify.ProxyConfiguration | undefined>}
 */
const proxyConfiguration = async ({
    proxyConfig,
    required = true,
    force = Apify.isAtHome(),
    blacklist = ['GOOGLESERP'],
    hint = [],
}) => {
    const configuration = await Apify.createProxyConfiguration(proxyConfig);

    // this works for custom proxyUrls
    if (Apify.isAtHome() && required) {
        if (!configuration || (!configuration.usesApifyProxy && (!configuration.proxyUrls || !configuration.proxyUrls.length)) || !configuration.newUrl()) {
            throw new Error('\n=======\nYou must use Apify proxy or custom proxy URLs\n\n=======');
        }
    }

    // check when running on the platform by default
    if (force) {
        // only when actually using Apify proxy it needs to be checked for the groups
        if (configuration && configuration.usesApifyProxy) {
            if (blacklist.some((blacklisted) => (configuration.groups || []).includes(blacklisted))) {
                throw new Error(`\n=======\nThese proxy groups cannot be used in this actor. Choose other group or contact support@apify.com to give you proxy trial:\n\n*  ${blacklist.join('\n*  ')}\n\n=======`);
            }

            // specific non-automatic proxy groups like RESIDENTIAL, not an error, just a hint
            if (hint.length && !hint.some((group) => (configuration.groups || []).includes(group))) {
                Apify.utils.log.info(`\n=======\nYou can pick specific proxy groups for better experience:\n\n*  ${hint.join('\n*  ')}\n\n=======`);
            }
        }
    }

    return configuration;
};

/**
 * Patch the crawler instance for new timeouts
 *
 * @param {Apify.BrowserCrawler} crawler
 * @param {number} handlePageTimeoutSecs
 */
const changeHandlePageTimeout = (crawler, handlePageTimeoutSecs) => {
    crawler.handlePageTimeoutSecs = handlePageTimeoutSecs;
    crawler.handlePageTimeoutMillis = handlePageTimeoutSecs * 1000;
    crawler.handleRequestTimeoutMillis = crawler.handlePageTimeoutMillis;
};

/**
 * Intercept home data API request and extract it's QueryID
 * @param {Puppeteer.Page} page
 * @param {Apify.ProxyInfo} proxy
 */
const interceptQueryId = async (page, proxy) => {
    await page.waitForFunction(() => {
        return [...document.scripts].some((s) => s.src.includes('variants-'));
    });

    const src = await page.evaluate(async () => {
        return [...document.scripts].find((s) => s.src.includes('variants-'))?.src;
    });

    try {
        if (!src) {
            throw new Error('src is missing');
        }

        const response = await requestAsBrowser({
            url: src,
            proxyUrl: proxy.url,
            abortFunction: () => false,
        });

        if (!response) {
            throw new Error('Response is empty');
        }

        if (![200, 304, 301, 302].includes(response.statusCode)) {
            throw new Error(`Status code ${response.statusCode}`);
        }

        const scriptContent = response.body;

        return {
            queryId: scriptContent.match(/ForSaleDoubleScrollFullRenderQuery:"([^"]+)"/)?.[1],
            clientVersion: scriptContent.match(/clientVersion:"([^"]+)"/)?.[1],
        };
    } catch (e) {
        log.debug(`interceptQueryId error ${e.message}`, { src });

        throw new Error('Failed to get queryId');
    }
};

/**
 * Split map into 4 sub-rectangles
 * @param {{ mapBounds: { mapZoom: number, south: number, east: number, north: number, west: number } }} queryState
 */
const splitQueryState = (queryState) => {
    if (typeof queryState !== 'object') {
        return [];
    }

    const qs = queryState;
    const mb = qs.mapBounds;
    const states = [{ ...qs }, { ...qs }, { ...qs }, { ...qs }];
    states.forEach((state) => { state.mapBounds = { ...mb }; });
    states[0].mapBounds.south = (mb.south + mb.north) / 2;
    states[0].mapBounds.east = (mb.east + mb.west) / 2;
    states[1].mapBounds.south = (mb.south + mb.north) / 2;
    states[1].mapBounds.west = (mb.east + mb.west) / 2;
    states[2].mapBounds.north = (mb.south + mb.north) / 2;
    states[2].mapBounds.east = (mb.east + mb.west) / 2;
    states[3].mapBounds.north = (mb.south + mb.north) / 2;
    states[3].mapBounds.west = (mb.east + mb.west) / 2;
    states.forEach((state) => { if (mb.mapZoom) { state.mapZoom = mb.mapZoom + 1; } });
    return states;
};

/**
 * @param {{ filterState: Record<string, any> }} qs
 * @param {keyof TYPES} type
 * @returns filter states
 */
const getQueryFilterStates = (qs, type) => {
    /**
     * Filter state must follow the exact format corresponding
     * to the Zillow API. False values cannot be ommited and
     * the exact number of query parameters has to be preserved.
     * Otherwise the request returns both list and map results empty.
     */

    const rentSoldCommonFilters = {
        isAllHomes: { value: true },
        isForSaleByAgent: { value: false },
        isForSaleByOwner: { value: false },
        isNewConstruction: { value: false },
        isComingSoon: { value: false },
        isAuction: { value: false },
        isForSaleForeclosure: { value: false },
    };

    const typeFilters = {
        sale: [{
            isAllHomes: { value: true },
        }],
        fsbo: [{
            isAllHomes: { value: true },
            isForSaleByOwner: { value: true },
        }],
        rent: [{
            isForRent: { value: true },
            ...rentSoldCommonFilters,
        }],
        sold: [{
            isRecentlySold: { value: true },
            ...rentSoldCommonFilters,
        }],
        /** @type {Array<any>} */
        all: [],
        /** qs is processed in translateQsToFilter (it comes from request.userData.searchQueryState), not from input.type) */
        qs: [qs.filterState],
    };

    /**
     * Zillow doesn't provide 'all' option at the moment,
     * for-sale and for-rent listings have different base url.
     * To extract all items, separate requests need to be sent.
     */
    typeFilters.all.push(...typeFilters.sale, ...typeFilters.rent); // TODO: should typeFilters.sold be included in typeFilters.all?

    return typeFilters[type];
};

/**
 * Make API query for all ZPIDs in map reqion
 * @param {{
 *  qs: { filterState: any },
 *  type: keyof TYPES,
 *  cat: 'cat1' | 'cat2'
 * }} queryState
 */
const queryRegionHomes = async ({ qs, cat = 'cat1' }) => {
    const wants = {
        [cat]: ['listResults', 'mapResults'],
    };

    const resp = await fetch(`https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeURIComponent(JSON.stringify(qs))}&wants=${JSON.stringify(wants)}&requestId=${Math.floor(Math.random() * 70) + 1}`, {
        body: null,
        headers: {
            dnt: '1',
            accept: '*/*',
            origin: document.location.origin,
            referer: document.location.href,
        },
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
    });

    if (resp.status !== 200) {
        throw new Error(`Got ${resp.status} from query`);
    }

    return {
        body: await (await resp.blob()).text(),
        qs,
    };
};

/**
 *
 * @param {Apify.Request} request
 * @param {keyof TYPES} inputType
 * @param {Puppeteer.Page} page
 * @param {any} pageQs
 * @param {Number} paginationPage
 * @returns query states with total count
 */
const extractQueryStates = async (request, inputType, page, pageQs, paginationPage = 1) => {
    /** @type { { states: Array<any>, totalCount: Number } } */
    const queryStates = {
        states: [],
        totalCount: 0,
    };

    const type = request.userData.searchQueryState ? 'qs' : inputType;
    const qs = translateQsToFilter(request.userData.searchQueryState || pageQs.queryState);
    qs.pagination = { currentPage: paginationPage };

    const filterStates = getQueryFilterStates(qs, type);

    const listingTypes = ['cat1', 'cat2']; // cat1 = agents listings, cat2 = other listings
    for (const cat of listingTypes) {
        const wants = {
            [cat]: ['listResults', 'mapResults'],
        };

        for (const filterState of filterStates) {
            qs.filterState = filterState;
            const url = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${JSON.stringify(qs)}&wants=${JSON.stringify(wants)}&requestId=${Math.floor(Math.random() * 70) + 1}`;
            log.debug(`Fetching url: ${url}`);

            const result = await page.evaluate(
                queryRegionHomes,
                {
                    qs: translateQsToFilter(request.userData.searchQueryState || pageQs.queryState),
                    cat,
                },
            );

            log.debug('query', result.qs);

            const searchState = JSON.parse(result.body);
            queryStates.states.push({ qs, searchState });

            await Apify.setValue('SEARCH_STATE', searchState);

            queryStates.totalCount += searchState?.categoryTotals?.[cat]?.totalResultCount ?? 0;
        }
    }

    return queryStates;
};

/**
 * Make API query for home data by ZPID. Needs to be initialized from createInterceptQueryId
 *
 * @param {string} queryId
 * @param {string} clientVersion
 * @returns {(page: Puppeteer.Page, zpid: string) => Promise<any>}
 */
const createQueryZpid = (queryId, clientVersion) => (page, zpid) => {
    return page.evaluate(async ({ zpid, queryId, clientVersion }) => {
        zpid = +zpid || zpid;

        const body = JSON.stringify({
            operationName: 'ForSaleDoubleScrollFullRenderQuery',
            variables: {
                zpid,
                contactFormRenderParameter: {
                    zpid,
                    platform: 'desktop',
                    isDoubleScroll: true,
                },
            },
            clientVersion,
            queryId,
        });

        const resp = await fetch(`https://www.zillow.com/graphql/?zpid=${zpid}&contactFormRenderParameter=&queryId=${queryId}&operationName=ForSaleDoubleScrollFullRenderQuery`, {
            method: 'POST',
            body,
            headers: {
                dnt: '1',
                accept: '*/*',
                'content-type': 'text/plain',
                origin: document.location.origin,
                pragma: 'no-cache',
                referer: `${document.location.origin}/`,
            },
            mode: 'cors',
            credentials: 'include',
        });

        if (resp.status !== 200) {
            throw new Error(`Got status ${resp.status} from GraphQL`);
        }

        return (await resp.blob()).text();
    }, { zpid, queryId, clientVersion });
};

/**
 * Simplify received home data
 *
 * @param {Record<string, boolean>} attributes
 */
const createGetSimpleResult = (attributes) => (data) => {
    /**
     * @type {Record<string, any>}
     */
    const result = {};

    if (!data) {
        return result;
    }

    for (const key in attributes) {
        if (key in data) { result[key] = data[key]; }
    }

    if (result.hdpUrl) {
        result.url = `https://www.zillow.com${result.hdpUrl}`;
        delete result.hdpUrl;
    }
    if (result.hugePhotos) {
        result.photos = result.hugePhotos.map((hp) => hp.url);
        delete result.hugePhotos;
    }
    return result;
};

/**
 * @param {any} data
 */
const quickHash = (data) => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 12);

/**
 * @param {string} url
 */
const getUrlData = (url) => {
    const nUrl = new URL(url, 'https://www.zillow.com');

    if (/\/\d+_zpid/.test(nUrl.pathname) || nUrl.pathname.startsWith('/b/')) {
        const zpid = nUrl.pathname.match(/\/(\d+)_zpid/);

        return {
            label: LABELS.DETAIL,
            zpid: zpid && zpid[1] ? +zpid[1] : '',
        };
    }

    if (nUrl.searchParams.has('searchQueryState')) {
        return {
            label: LABELS.QUERY,
            searchQueryState: JSON.parse(nUrl.searchParams.get('searchQueryState')),
        };
    }

    if (nUrl.pathname.startsWith('/homes')) {
        return {
            label: LABELS.QUERY,
        };
    }

    if (nUrl.pathname.match(/\/(fsbo|rent|sale|sold)\/?/)) {
        throw new Error(`\n\nThe url provided "${nUrl.toString()}" isn't supported. Use a proper listing url containing searchQueryState\n\n`);
    }

    const label = nUrl.pathname.includes(',') ? LABELS.SEARCH : LABELS.QUERY;
    return {
        label,
        term: label === LABELS.SEARCH ? nUrl.pathname.split('/', 2).filter((s) => s)[0] : undefined,
    };
};

/**
 * @template T
 * @typedef {T & { Apify: Apify, customData: any, request: Apify.Request }} PARAMS
 */

/**
 * Compile a IO function for mapping, filtering and outputing items.
 * Can be used as a no-op for interaction-only (void) functions on `output`.
 * Data can be mapped and filtered twice.
 *
 * Provided base map and filter functions is for preparing the object for the
 * actual extend function, it will receive both objects, `data` as the "raw" one
 * and "item" as the processed one.
 *
 * Always return a passthrough function if no outputFunction provided on the
 * selected key.
 *
 * @template RAW
 * @template {{ [key: string]: any }} INPUT
 * @template MAPPED
 * @template {{ [key: string]: any }} HELPERS
 * @param {{
    *  key: string,
    *  map?: (data: RAW, params: PARAMS<HELPERS>) => Promise<MAPPED>,
    *  output?: (data: MAPPED, params: PARAMS<HELPERS> & { data: RAW, item: MAPPED }) => Promise<void>,
    *  filter?: (obj: { data: RAW, item: MAPPED }, params: PARAMS<HELPERS>) => Promise<boolean>,
    *  input: INPUT,
    *  helpers: HELPERS,
    * }} params
    * @return {Promise<(data: RAW, args?: Record<string, any>) => Promise<void>>}
    */
const extendFunction = async ({
    key,
    output,
    filter,
    map,
    input,
    helpers,
}) => {
    /**
     * @type {PARAMS<HELPERS>}
     */
    const base = {
        ...helpers,
        Apify,
        customData: input.customData || {},
    };

    const evaledFn = (() => {
        // need to keep the same signature for no-op
        if (typeof input[key] !== 'string' || input[key].trim() === '') {
            return new vm.Script('({ item }) => item');
        }

        try {
            return new vm.Script(input[key], {
                lineOffset: 0,
                produceCachedData: false,
                displayErrors: true,
                filename: `${key}.js`,
            });
        } catch (e) {
            throw new Error(`"${key}" parameter must be a function`);
        }
    })();

    /**
     * Returning arrays from wrapper function split them accordingly.
     * Normalize to an array output, even for 1 item.
     *
     * @param {any} value
     * @param {any} [args]
     */
    const splitMap = async (value, args) => {
        const mapped = map ? await map(value, args) : value;

        if (!Array.isArray(mapped)) {
            return [mapped];
        }

        return mapped;
    };

    return async (data, args) => {
        const merged = { ...base, ...args };

        for (const item of await splitMap(data, merged)) {
            if (filter && !(await filter({ data, item }, merged))) {
                continue; // eslint-disable-line no-continue
            }

            const result = await (evaledFn.runInThisContext()({
                ...merged,
                data,
                item,
            }));

            for (const out of (Array.isArray(result) ? result : [result])) {
                if (output) {
                    if (out !== null) {
                        await output(out, { ...merged, data, item });
                    }
                    // skip output
                }
            }
        }
    };
};

/**
 * @param {*} value
 * @returns
 */
const parseTimeUnit = (value) => {
    if (!value) {
        return null;
    }

    if (value === 'today' || value === 'yesterday') {
        return (value === 'today' ? moment() : moment().subtract(1, 'day')).startOf('day');
    }

    const [, number, unit] = `${value}`.match(/^(\d+)\s?(minute|second|day|hour|month|year|week)s?$/i) || [];

    if (+number && unit) {
        return moment().subtract(+number, unit);
    }

    return moment(value);
};

/**
 * @typedef MinMax
 * @property {number | string} [min]
 * @property {number | string} [max]
 */

/**
 * @typedef {ReturnType<typeof minMaxDates>} MinMaxDates
 */

/**
 * Generate a function that can check date intervals depending on the input
 * @param {MinMax} param
 */
const minMaxDates = ({ min, max }) => {
    const minDate = parseTimeUnit(min);
    const maxDate = parseTimeUnit(max);

    if (minDate && maxDate && maxDate.diff(minDate) < 0) {
        throw new Error(`Minimum date ${minDate.toString()} needs to be less than max date ${maxDate.toString()}`);
    }

    return {
        /**
         * cloned min date, if set
         */
        get minDate() {
            return minDate?.clone();
        },
        /**
         * cloned max date, if set
         */
        get maxDate() {
            return maxDate?.clone();
        },
        /**
         * compare the given date/timestamp to the time interval
         * @param {string | number} time
         */
        compare(time) {
            const base = moment(time);
            return (minDate ? minDate.diff(base) <= 0 : true) && (maxDate ? maxDate.diff(base) >= 0 : true);
        },
    };
};

/**
 * @param {Apify.BasicCrawler} crawler
 */
const patchLog = (crawler) => {
    const originalException = crawler.log.exception.bind(crawler.log);
    crawler.log.exception = (...args) => {
        if (!args?.[1]?.includes('handleRequestFunction')) {
            originalException(...args);
        }
    };
};

/**
 * @param {{
 *  zpids: Set<any>,
 *  input: { maxItems: Number},
 * }} globalContext
 * @param {Number} extra
 * @returns is over items bool result
 */
const isOverItems = ({ zpids, input }, extra = 0) => (typeof input.maxItems === 'number' && input.maxItems > 0
    ? (zpids.size + extra) >= input.maxItems
    : false);

module.exports = {
    createGetSimpleResult,
    createQueryZpid,
    interceptQueryId,
    extractQueryStates,
    splitQueryState,
    extendFunction,
    proxyConfiguration,
    quickHash,
    getUrlData,
    makeInputBackwardsCompatible,
    minMaxDates,
    patchLog,
    changeHandlePageTimeout,
    isOverItems,
};
