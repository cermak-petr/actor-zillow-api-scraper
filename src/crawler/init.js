const Apify = require('apify');
const {
    proxyConfiguration,
    initResultShape,
    makeInputBackwardsCompatible,
    getUrlData,
    extendFunction,
    initPersistence,
    isEnoughItemsCollected,
    interceptQueryId,
    createQueryZpid
} = require("../functions");
const {LABELS, TYPES} = require('../constants');
const uuid = require('uuid').v4;
const _ = require('lodash');
const {log} = Apify.utils;

class RetireError extends Error {

}


async function initProxyConfig(input) {
    const proxyConfig = await proxyConfiguration({
        proxyConfig: {
            ...input.proxyConfiguration,
        },
        hint: ['RESIDENTIAL'],
    });

    if (proxyConfig?.groups?.includes('RESIDENTIAL')) {
        proxyConfig.countryCode = 'US';
    }

    return proxyConfig;
}

async function initCrawler(input, isDebug, proxyConfig) {
    // Check input
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids) {
        throw new Error('Either "search", "startUrls" or "zpids" attribute has to be set!');
    }

    // Initialize minimum time
    const minTime = input.minDate ? (+input.minDate || new Date(input.minDate).getTime()) : null;

    const maxItems = input.maxItems;

    // Toggle showing only a subset of result attributes
    const getSimpleResult = initResultShape(input.simple)

    const zpids = await initPersistence();

    // TODO: temp hack to get around empty output. remove this after merge to master
    makeInputBackwardsCompatible(input);

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

    await requestQueue.addRequest({
        url: 'https://www.zillow.com/homes/',
        uniqueKey: `${uuid()}`,
        userData: {
            label: LABELS.INITIAL,
        },
    }, {forefront: true});

    const extendOutputFunction = await extendFunction({
        map: async (data) => {
            return getSimpleResult(data);
        },
        filter: async ({data}) => {
            if (isEnoughItemsCollected(input.maxItems, zpids)) {
                return false;
            }

            if (!_.get(data, 'zpid')) {
                return false;
            }

            return (minTime ? data.datePosted <= minTime : true)
                && !zpids.has(`${data.zpid}`);
        },
        output: async (output, {data}) => {
            zpids.add(`${data.zpid}`);
            await Apify.pushData(output);
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            _,
            zpids,
            minTime,
            TYPES,
            LABELS,
        },
    });

    const extendScraperFunction = await extendFunction({
        output: async () => {
        }, // no-op
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
            extendOutputFunction,
            minTime,
        },
    });

    return {
        startUrls: startUrls,
        requestQueue: requestQueue,
        extendOutputFunction: extendOutputFunction,
        extendScraperFunction: extendScraperFunction,
        queryZpid: queryZpid,
        zpids: zpids,
        maxItems: maxItems,
    }
}

async function handleInitialCrawl(page, requestQueue, startUrls, autoscaledPool) {
    log.info('Trying to get queryId...');

    const {queryId, clientVersion} = await interceptQueryId(page);

    log.debug('Intercepted queryId', {queryId, clientVersion});

    const queryZpid = createQueryZpid(queryId, clientVersion, await page.cookies());

    autoscaledPool.maxConcurrency = 5;

    // now that we initialized, we can add the requests
    for (const req of startUrls) {
        await requestQueue.addRequest(req);
    }

    log.info('Got queryId, continuing...');

    return queryZpid;
}

module.exports = {
    initResultShape,
    initProxyConfig,
    initCrawler,
    handleInitialCrawl,
    RetireError,
};
