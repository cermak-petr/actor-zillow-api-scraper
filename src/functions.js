const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const { createHash } = require('crypto');
const { TYPES } = require('./constants');

const { sleep } = Apify.utils;

const deferred = () => {
    /** @type {(...args: any) => void} */
    let resolve = () => {};
    /** @type {(err: Error) => void} */
    let reject = () => {};

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
            throw new Error('\n=======\nYou\'re required to provide a valid proxy configuration\n\n=======');
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
        sleep(30000).then(() => reject(new Error('Failed to find queryId'))),
        promise,
    ]);
};

/**
 * Split map into 4 sub-rectangles
 * @param {{ mapBounds: { mapZoom: number, south: number, east: number, north: number, west: number } }} queryState
 */
const splitQueryState = (queryState) => {
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
    }

    const requestId = Math.round(Math.random() * 30) + 1;
    const resp = await fetch(`https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=${encodeURIComponent(JSON.stringify(qs))}&requestId=${requestId}`, {
        body: null,
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
    });
    return (await resp.blob()).text();
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
                'Content-Type': 'text/plain',
            },
            mode: 'cors',
            credentials: 'include',
        });

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

module.exports = {
    createGetSimpleResult,
    createQueryZpid,
    interceptQueryId,
    queryRegionHomes,
    splitQueryState,
    proxyConfiguration,
    quickHash,
};
