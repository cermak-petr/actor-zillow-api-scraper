const Apify = require('apify');
const moment = require('moment');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { createHash } = require('crypto');
const vm = require('vm');
const { bboxPolygon, bbox, area, squareGrid } = require('@turf/turf');
const { LABELS, TYPES, ORIGIN, GetSearchPageState, SearchQueryState } = require('./constants'); // eslint-disable-line no-unused-vars

const { log } = Apify.utils;

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
    '55plus': 'ageRestricted55Plus',
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

const reverseMappings = Object.entries(mappings).reduce((out, [key, value]) => {
    out[value] = key;
    return out;
}, {});

/**
 * Transforms searchQueryState URL parameters into filters if needed
 *
 * @param {Record<string, any>} filter
 */
const translateQsToFilter = (filter) => {
    if (!filter || typeof filter !== 'object') {
        return {};
    }

    return Object.entries(filter).reduce((out, [key, value]) => {
        out[mappings[key] ?? key] = value;
        return out;
    }, {});
};

/**
 * Translate a filter back to QS
 *
 * @param {Record<string, any>} filter
 */
const translateFilterToQs = (filter) => {
    if (!filter || typeof filter !== 'object') {
        return {};
    }

    return Object.entries(filter).reduce((out, [key, value]) => {
        out[reverseMappings[key] ?? key] = value;
        return out;
    }, {});
};

/**
 * @param {number | string | null | undefined} zpid
 */
const normalizeZpid = (zpid) => {
    // empty string, 0, null, etc
    if (!zpid) {
        return;
    }

    // zpids are numbers, and sometimes are strings. they should be the same when converting
    // some zpids are invalid, like 30.213--51.251. casting + makes it NaN
    if (zpid != +zpid) {
        return;
    }

    return `${zpid}`;
};

/**
 * Deals with normalizing and keeping track of zpids to avoid
 * duplicates and extra work
 *
 * @param {number} maxItems
 */
const createZpidsHandler = async (maxItems) => {
    /** @type {Set<string>} */
    const zpids = new Set(await Apify.getValue('STATE'));

    maxItems = +maxItems ? +maxItems : 0;
    const initialCount = zpids.size;

    const persistState = async () => {
        await Apify.setValue('STATE', [...zpids.values()]);
    };

    Apify.events.on('aborting', persistState);
    Apify.events.on('migrating', persistState);

    return {
        persistState,
        /** @param {number} [extra] */
        isOverItems(extra = 0) {
            return maxItems > 0
                ? zpids.size + initialCount + extra >= +maxItems
                : false;
        },
        get count() {
            return zpids.size;
        },
        /**
         * @param {number | undefined | string} zpid
         */
        has(zpid) {
            zpid = normalizeZpid(zpid);

            if (!zpid) {
                return false;
            }

            return zpids.has(zpid);
        },
        /**
         * @param {number | undefined | string} zpid
         * @returns zpid was added to the global store
         */
        add(zpid, key = 'DEFAULT') {
            zpid = normalizeZpid(zpid);

            if (!zpid) {
                return false;
            }

            if (zpids.has(zpid)) {
                return false;
            }

            zpids.add(zpid);

            return true;
        },
    };
};

/**
 * @typedef {Awaited<ReturnType<typeof createZpidsHandler>>} ZpidHandler
 */

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
 * @param {Apify.BrowserCrawler | null} crawler
 * @param {number} handlePageTimeoutSecs
 */
const changeHandlePageTimeout = (crawler, handlePageTimeoutSecs) => {
    if (crawler) {
        crawler.handlePageTimeoutSecs = handlePageTimeoutSecs;
        crawler.handlePageTimeoutMillis = handlePageTimeoutSecs * 1000;
        crawler.handleRequestTimeoutMillis = crawler.handlePageTimeoutMillis;
    }
};

/**
 * Split map into many areas according to zoom
 * @param {SearchQueryState} queryState
 * @returns {Array<queryState>}
 */
const splitQueryState = (queryState) => {
    if (typeof queryState !== 'object') {
        return [];
    }

    const qs = queryState;
    const mb = qs.mapBounds;

    if (!mb) {
        log.debug('no mapBounds');
        return [queryState];
    }

    const box = bboxPolygon([
        mb.west,
        mb.south,
        mb.east,
        mb.north,
    ]);

    /**
     * @type {Array<queryState>}
     */
    const states = [];

    const isBigAreaToCover = !qs.mapZoom || qs.mapZoom < 10;
    const a = (Math.sqrt(area(box)) / (isBigAreaToCover ? 1000 : 1)) / 4;
    const grid = squareGrid(bbox(box), a, {
        units: isBigAreaToCover ? 'kilometers' : 'meters',
    });

    grid.features.forEach(({ geometry }) => {
        const [west, south, east, north] = bbox(geometry);

        states.push({
            ...qs,
            mapBounds: {
                west,
                south,
                east,
                north,
            },
            // eslint-disable-next-line no-nested-ternary
            mapZoom: qs.mapZoom
                ? (qs.mapZoom < 19 ? qs.mapZoom + 1 : qs.mapZoom)
                : 9,
        });
    });

    return states;
};

/**
 * N.B: This should be only used for GetSearchPageState.htm requests!
 *
 * @param {SearchQueryState['filterState']} filterState
 * @param {keyof TYPES} type
 * @returns filter states
 */
const getQueryFilterStates = (filterState, type) => {
    /**
     * Filter state must follow the exact format corresponding
     * to the Zillow API. False values cannot be ommited and
     * the exact number of query parameters has to be preserved.
     * Otherwise the request returns both list and map results empty.
     */
    const rentSoldCommonFilters = {
        isForSaleByAgent: { value: false },
        isNewConstruction: { value: false },
        isComingSoon: { value: false },
        isForSaleForeclosure: { value: false },
    };

    const needed = {
        sortSelection: { value: 'globalrelevanceex' },
        isAllHomes: { value: true },
    };

    const typeFilters = {
        sale: [{
            ...needed,
            isForRent: { value: false },
            isRecentlySold: { value: false },
        }],
        fsbo: [{
            ...needed,
            isForSaleByAgent: { value: false },
            isForSaleByOwner: { value: true },
        }],
        rent: [{
            ...needed,
            isForRent: { value: true },
            ...rentSoldCommonFilters,
        }],
        sold: [{
            ...needed,
            ...rentSoldCommonFilters,
            isForRent: { value: false },
            isRecentlySold: { value: true },
        }],
        /** @type {Array<any>} */
        all: [],
        /** qs is processed in translateQsToFilter, not from input.type) */
        qs: [filterState],
    };

    /**
     * Zillow doesn't provide 'all' option at the moment,
     * for-sale and for-rent listings have different base url.
     * To extract all items, separate requests need to be sent.
     */
    typeFilters.all.push(
        ...typeFilters.sale,
        ...typeFilters.sold,
        ...typeFilters.rent,
    );

    return typeFilters[type];
};

/**
 * Make API query for all ZPIDs in map reqion
 * @param {{
 *  qs: SearchQueryState,
 *  wants: Record<string, any>
 * }} params
 */
const queryRegionHomes = async (params) => {
    const { qs, wants } = params;

    const url = `https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeURIComponent(JSON.stringify(qs))}&wants=${encodeURIComponent(JSON.stringify(wants))}&requestId=${Math.floor(Math.random() * 10) + 1}`;
    const resp = await fetch(url, {
        headers: {
            accept: '*/*',
        },
        method: 'GET',
        mode: 'cors',
        credentials: 'include',
    });

    const ret = {
        qs,
        url,
        params,
        error: resp.status !== 200 ? `Got ${resp.status} from query` : null,
    };

    return {
        ...ret,
        body: await (await resp.blob()).text(), // .json() crashes if not valid JSON. this is dealt elsewhere
    };
};

/**
 *
 * @param {keyof TYPES} inputType
 * @param {Puppeteer.Page} page
 * @param {SearchQueryState} pageQueryState
 * @param {(param: { cat: 'cat1' | 'cat2', qs: SearchQueryState, url: string, hash: string, result: GetSearchPageState }) => Promise<void>} cb
 * @param {number} [paginationPage]
 */
const extractQueryStates = async (inputType, page, pageQueryState, cb, paginationPage = 1) => {
    const queryStates = new Set();
    const isDebug = log.getLevel() === log.LEVELS.DEBUG;

    const filterStates = getQueryFilterStates(translateQsToFilter(pageQueryState.filterState), inputType);

    log.debug(`Filter states`, { inputType, count: filterStates.length });

    /** @type {Array<['cat1' | 'cat2', any]>} */
    const configs = [
        ['cat1', { cat1: ['listResults', 'mapResults'], cat2: ['total'] }],
        ['cat2', { cat2: ['listResults', 'mapResults'] }],
    ];

    for (const [cat, wants] of configs) {
        for (const filterState of filterStates) {
            const response = await page.evaluate(
                queryRegionHomes,
                {
                    qs: {
                        ...pageQueryState,
                        filterState,
                        category: cat,
                        pagination: (paginationPage > 1 ? { currentPage: paginationPage } : {}),
                    },
                    wants,
                    cat,
                },
            );

            if (response.error) {
                log.debug(`Request failed`, { pageQueryState, response });

                if (isDebug) {
                    await Apify.setValue(getUniqueKeyFromQueryState(response.qs), response);
                }

                continue;
            }

            /**
             * @type {GetSearchPageState}
             */
            const result = JSON.parse(response.body);
            const { qs, url } = response;

            log.debug(`Fetch url: ${response.url}`, { url, qs });

            const hash = getUniqueKeyFromQueryState(qs, [cat, wants]);

            if (!queryStates.has(hash)) {
                queryStates.add(hash);

                await cb({
                    result,
                    qs,
                    cat,
                    hash,
                    url,
                });
            }

            if (isDebug) {
                await Apify.setValue(`SEARCH_STATE-${hash}`, result);
            }
        }
    }
};

/**
 *
 * @param { {
 *      zpid: any,
 *      queryId: any,
 *      detailUrl: string,
 *      clientVersion: any
 * }} requestParams
 * @returns
 */
const evaluateQueryZpid = async ({ zpid, detailUrl, queryId, clientVersion }) => {
    zpid = +zpid || zpid;

    const body = JSON.stringify({
        operationName: 'ForSaleDoubleScrollFullRenderQuery',
        variables: {
            zpid,
            contactFormRenderParameter: {
                isDoubleScroll: true,
                platform: 'desktop',
                zpid,
            },
        },
        clientVersion,
        queryId,
    });

    const clientId = (clientVersion.includes('/')
        ? clientVersion.split('/', 2)?.filter?.((r) => r.includes('-')).shift()?.concat('_r')
            .trim()
        : null) || 'home-details_r';

    const resp = await fetch(`https://www.zillow.com/graphql/?zpid=${zpid}&contactFormRenderParameter=&queryId=${queryId}&operationName=ForSaleDoubleScrollFullRenderQuery`, {
        method: 'POST',
        body,
        headers: {
            'client-id': clientId,
            accept: '*/*',
            'content-type': 'application/json',
            origin: document.location.origin,
        },
        referrer: document.location.pathname.includes('/homedetails/')
            ? document.location.href
            : (detailUrl ? detailUrl : undefined),
        mode: 'cors',
        credentials: 'include',
    });

    if (resp.status !== 200) {
        throw new Error(`Got status ${resp.status} from GraphQL`);
    }

    return (await resp.blob()).text();
};

/**
 * Make API query for home data by ZPID. Needs to be initialized from createInterceptQueryId
 *
 * @param {string} queryId
 * @param {string} clientVersion
 * @returns {(page: Puppeteer.Page, zpid: string, detailUrl: string) => Promise<any>}
 */
const createQueryZpid = (queryId, clientVersion) => (page, zpid, detailUrl) => {
    // evaluateQueryZpid is a separate function to avoid scope variables re-declaration (zpid, queryId, clientVersion)
    return page.evaluate(evaluateQueryZpid, { zpid, queryId, clientVersion, detailUrl });
};

/**
 * Simplify received home data
 *
 * @param {Record<string, boolean>} attributes
 */
const createGetSimpleResult = (attributes) => (/** @type {any} */ data) => {
    /**
     * @type {Record<string, any>}
     */
    const result = {};

    if (!data) {
        return result;
    }

    Object.keys(attributes).forEach((key) => {
        // allow 0 and null values to be output. undefined will be omitted anyway
        if (key in data) {
            result[key] = data[key];
        }
    });

    if (result.hdpUrl) {
        result.url = (new URL(result.hdpUrl, ORIGIN)).toString();
        delete result.hdpUrl;
    }

    if (result.responsivePhotos) {
        result.photos = result.responsivePhotos.map((/** @type {{ url: String }} */ hp) => hp.url);
        delete result.responsivePhotos;
    }

    return result;
};

/**
 * JSON.stringify the input and sha256 it
 *
 * @param {Array<any> | Record<string, any>} data
 */
const quickHash = (data) => createHash('sha256')
    .update(JSON.stringify(data))
    .digest('hex')
    .slice(0, 14);

/**
 * Apply a label to the given URL for userData. Throws if couldn't be categorized
 *
 * @param {string} url
 */
const getUrlData = (url) => {
    const nUrl = new URL(url, ORIGIN);

    if (/\/\d+_zpid/.test(nUrl.pathname) || nUrl.pathname.startsWith('/b/')) {
        const zpid = normalizeZpid(nUrl.pathname.match(/\/(\d+)_zpid/)?.[1]);

        return {
            label: LABELS.DETAIL,
            zpid,
        };
    }

    if (nUrl.searchParams.has('searchQueryState')) {
        return {
            label: LABELS.QUERY,
            ignoreFilter: true,
        };
    }

    if (nUrl.pathname.includes('_rb/')) {
        return {
            label: LABELS.QUERY,
        };
    }

    throw new Error(`\n\n\n\nThe url provided "${nUrl.toString()}" isn't supported. Use a proper listing url containing a ?searchQueryState= parameter\n\n\n\n`);
};

/**
 * Create a unique key for the given state. URLs can't be used for
 * uniqueKeys because they are only representational, the true value is in the
 * query parameter.
 *
 * This is deterministic and will generate the same hash for the given parameters.
 *
 * @param {SearchQueryState} queryState
 * @param {string[]} nonce
 */
const getUniqueKeyFromQueryState = (queryState, nonce = []) => {
    return quickHash([
        queryState.mapZoom || 10, // when no zoom is present, it's 10. needs to be enforced here so we don't get duplicates
        [
            queryState.mapBounds?.west,
            queryState.mapBounds?.east,
            queryState.mapBounds?.north,
            queryState.mapBounds?.south,
        ],
        queryState.pagination?.currentPage || 1,
        // sort the keys so they are always the same
        Object.entries(queryState.filterState ?? {}).sort(([key1], [key2]) => `${key1}`.localeCompare(`${key2}`)),
        nonce,
    ]);
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
 * Allows relative dates like `1 month` or `12 minutes`,
 * yesterday and today.
 * Parses unix timestamps in milliseconds and absolute dates in ISO format
 *
 * @param {string|number|Date} value
 * @param {boolean} inTheFuture
 */
const parseTimeUnit = (value, inTheFuture) => {
    if (!value) {
        return null;
    }

    if (value instanceof Date) {
        return moment.utc(value);
    }

    switch (value) {
        case 'today':
        case 'yesterday': {
            const startDate = (value === 'today' ? moment.utc() : moment.utc().subtract(1, 'day'));

            return inTheFuture
                ? startDate.endOf('day')
                : startDate.startOf('day');
        }
        default: {
            // valid integer, needs to be typecast into a number
            // non-milliseconds needs to be converted to milliseconds
            if (+value == value) {
                return moment.utc(+value / 1e10 < 1 ? +value * 1000 : +value, true);
            }

            const [, number, unit] = `${value}`.match(/^(\d+)\s?(minute|second|day|hour|month|year|week)s?$/i) || [];

            if (+number && unit) {
                return inTheFuture
                    ? moment.utc().add(+number, unit)
                    : moment.utc().subtract(+number, unit);
            }
        }
    }

    const date = moment.utc(value);

    if (!date.isValid()) {
        return null;
    }

    return date;
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
    const minDate = parseTimeUnit(min, false);
    const maxDate = parseTimeUnit(max, true);

    if (minDate && maxDate && maxDate.diff(minDate) < 0) {
        throw new Error(`Minimum date ${minDate.toString()} needs to be less than max date ${maxDate.toString()}`);
    }

    return {
        get isComparable() {
            return !!minDate || !!maxDate;
        },
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
         * compare the given date/timestamp to the time interval.
         * never fails or throws.
         *
         * @param {string | number} time
         */
        compare(time) {
            const base = parseTimeUnit(time, false);
            return (minDate ? minDate.diff(base) <= 0 : true) && (maxDate ? maxDate.diff(base) >= 0 : true);
        },
    };
};

/**
 * @param {Apify.BasicCrawler} crawler
 */
const patchLog = (crawler) => {
    const originalException = crawler.log.exception.bind(crawler.log);
    crawler.log.exception = (/** @type {any[]} */ ...args) => {
        if (!args?.[1]?.includes('handleRequestFunction')) {
            originalException(...args);
        }
    };
};

module.exports = {
    createGetSimpleResult,
    createQueryZpid,
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
    createZpidsHandler,
    normalizeZpid,
    translateFilterToQs,
    getUniqueKeyFromQueryState,
};
