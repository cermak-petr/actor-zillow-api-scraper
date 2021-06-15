const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { createHash } = require('crypto');
const vm = require('vm');
const { TYPES, LABELS } = require('./constants');

const { sleep } = Apify.utils;

/**
 * @param {Record<string,any>} input
 */
const makeInputBackwardsCompatible = (input) => {
    if (input && input.extendOutputFunction === '(data) => {\n    return {};\n}') {
        input.extendOutputFunction = '';
    }
};

const deferred = () => {
    /** @type {(...args: any) => void} */
    let resolve = () => { };
    /** @type {(err: Error) => void} */
    let reject = () => { };

    const promise = new Promise((r1, r2) => {
        resolve = /** @type {any} */(r1);
        reject = r2;
    });

    return {
        resolve,
        reject,
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
 * Intercept home data API request and extract it's QueryID
 * @param {Puppeteer.Page} page
 */
const interceptQueryId = async (page) => {
    const { promise, resolve, reject } = deferred();

    await page.setRequestInterception(true);

    page.on('request', (r) => {
        const url = r.url();

        if (url.includes('https://www.zillow.com/graphql')) {
            const payload = r.postData();

            if (payload) {
                try {
                    const data = JSON.parse(payload);

                    if (data.operationName === 'ForSaleDoubleScrollFullRenderQuery') {
                        resolve(data);
                    }
                } catch (e) { }
            }
        }

        r.continue();
    });

    await page.waitForSelector('a.list-card-link');
    await page.click('a.list-card-link');

    return Promise.race([
        sleep(60000).then(() => reject(new Error('Failed to find queryId'))),
        promise,
    ]);
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
 * Make API query for all ZPIDs in map reqion
 * @param {{
 *  qs: { filterState: any },
 *  type: keyof TYPES
 * }} queryState
 */
const queryRegionHomes = async ({ qs, type }) => {
    if (type === 'rent') {
        qs.filterState = {
            isForSaleByAgent: { value: false },
            isForSaleByOwner: { value: false },
            isNewConstruction: { value: false },
            isForSaleForeclosure: { value: false },
            isComingSoon: { value: false },
            isAuction: { value: false },
            isPreMarketForeclosure: { value: false },
            isPreMarketPreForeclosure: { value: false },
            isForRent: { value: true },
        };
    } else if (type === 'fsbo') {
        qs.filterState = {
            isForSaleByAgent: { value: false },
            isForSaleByOwner: { value: true },
            isNewConstruction: { value: false },
            isForSaleForeclosure: { value: false },
            isComingSoon: { value: false },
            isAuction: { value: false },
            isPreMarketForeclosure: { value: false },
            isPreMarketPreForeclosure: { value: false },
            isForRent: { value: false },
        };
    } else if (type === 'sold') {
        qs.filterState = {
            sortSelection: { value: 'globalrelevanceex' },
            isAllHomes: { value: true },
            isRecentlySold: { value: true },
            isForSaleByAgent: { value: false },
            isForSaleByOwner: { value: false },
            isNewConstruction: { value: false },
            isComingSoon: { value: false },
            isAuction: { value: false },
            isForSaleForeclosure: { value: false },
            isPreMarketForeclosure: { value: false },
            isPreMarketPreForeclosure: { value: false },
        };
    } else if (type === 'all') {
        qs.filterState = {
            isPreMarketForeclosure: { value: true },
            isForSaleForeclosure: { value: true },
            sortSelection: { value: 'globalrelevanceex' },
            isAuction: { value: true },
            isNewConstruction: { value: true },
            isRecentlySold: { value: true },
            isForSaleByOwner: { value: true },
            isComingSoon: { value: true },
            isPreMarketPreForeclosure: { value: true },
            isForSaleByAgent: { value: true },
        };
    } else if (type === 'qs') {
        qs.filterState.isAllHomes = { value: true };
    }

    try {
        delete qs.filterState.ah;
    } catch (e) {}

    const wants = { cat1: ['listResults', 'mapResults'] };

    const resp = await fetch(`https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeURIComponent(JSON.stringify(qs))}&wants=${JSON.stringify(wants)}&requestId=${Math.floor(Math.random() * 10) + 1}`, {
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
        throw `Got ${resp.status} from query`;
    }

    return {
        body: await (await resp.blob()).text(),
        qs,
    };
};

/**
 * Make API query for home data by ZPID. Needs to be initialized from createInterceptQueryId
 *
 * @param {string} queryId
 * @param {string} clientVersion
 * @param {Puppeteer.Cookie[]} cookies
 * @returns {(page: Puppeteer.Page, zpid: string) => Promise<any>}
 */
const createQueryZpid = (queryId, clientVersion, cookies) => (page, zpid) => {
    return page.evaluate(async ({ zpid, queryId, clientVersion }) => { // eslint-disable-line no-shadow
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
                referer: `${document.location.origin}/`,
            },
            mode: 'cors',
            credentials: 'omit',
        });

        if (resp.status !== 200) {
            throw `Got status ${resp.status} from GraphQL`;
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
        if (data[key]) { result[key] = data[key]; }
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
            queryState: JSON.parse(nUrl.searchParams.get('searchQueryState')),
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

function initResultShape(isSimple) {
    return createGetSimpleResult(
        isSimple
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
}


async function initPersistence() {
    const zpids = new Set(await Apify.getValue('STATE'));

    Apify.events.on('migrating', async () => {
        await Apify.setValue('STATE', [...zpids.values()]);
    });

    return zpids;
}


module.exports = {
    createGetSimpleResult,
    createQueryZpid,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    extendFunction,
    proxyConfiguration,
    quickHash,
    getUrlData,
    makeInputBackwardsCompatible,
    initResultShape,
    initPersistence,
};
