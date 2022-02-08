const Apify = require('apify');
const { TYPES, LABELS } = require('./constants');

const fns = require('./functions');

const { utils: { log } } = Apify;

const {
    getUrlData,
    extendFunction,
    isOverItems,
    // eslint-disable-next-line no-unused-vars
    createGetSimpleResult,
} = fns;

/**
 * Throws error if the provided input is invalid.
 * @param {{ search: String, startUrls: any[], zpids: any[] }} input
 */
const validateInput = (input) => {
    if (!(input.search && input.search.trim().length > 0) && !input.startUrls && !input.zpids) {
        throw new Error('Either "search", "startUrls" or "zpids" attribute has to be set!');
    }
};

/**
 *
 * @param {{ search: string, startUrls: any[], type: string, zpids: any[] }} input
 * @returns startUrls
 */
const getInitializedStartUrls = async (input) => {
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

        /**
         * requestList.fetchNextRequest() gets Request object from requestsFromUrl property
         * which holds start url parsed by RequestList
         */
        let req;
        while (req = await requestList.fetchNextRequest()) { // eslint-disable-line no-cond-assign
            if (!req.url.includes('zillow.com')) {
                throw new Error(`Invalid startUrl ${req.url}. Url must start with: https://www.zillow.com`);
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

    return startUrls;
};

/**
 *
 * @param {{ debugLog: boolean, handlePageTimeoutSecs: any}} input
 * @param {ReturnType<typeof fns.createQueryZpid> | null} queryZpid
 * @param {{crawler: Apify.PuppeteerCrawler | null}} crawlerWrapper
 * @returns initialized preLaunchHooks
 */
const initializePreLaunchHooks = (input, queryZpid, { crawler }) => {
    return [async (/** @type {any} */ _pageId, /** @type {{ launchOptions: any; }} */ launchContext) => {
        launchContext.launchOptions = {
            ...launchContext.launchOptions,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            devtools: input.debugLog,
            headless: false,
        };
        launchContext.useIncognitoPages = true;

        if (queryZpid !== null) {
            fns.changeHandlePageTimeout(crawler, input.handlePageTimeoutSecs || 3600);
        }
    }];
};

/**
 *
 * @param {{
 *  zpids: Set<any>,
 *  input: {
 *      maxItems: Number,
 *      startUrls: Array<Apify.RequestOptions>,
 *      type: String
 *  },
 * }} globalContext
 * @param {*} minMaxDate
 * @param {ReturnType<createGetSimpleResult>} getSimpleResult
 * @returns
 */
const getExtendOutputFunction = async ({ zpids, input }, minMaxDate, getSimpleResult) => {
    const extendOutputFunction = await extendFunction({
        map: async (data) => getSimpleResult(data),
        filter: async ({ data }) => {
            if (isOverItems({ zpids, input })) {
                return false;
            }

            if (!data?.zpid) {
                return false;
            }

            if (!minMaxDate.compare(data.datePosted) || zpids.has(`${data.zpid}`)) {
                return false;
            }

            if (input.startUrls) {
                // ignore input.type when it is set in start url
                return true;
            }

            switch (input.type) {
                case 'sale':
                    return data.homeStatus === 'FOR_SALE';
                case 'fsbo':
                    return data.homeStatus === 'FOR_SALE' && data.keystoneHomeStatus === 'ForSaleByOwner';
                case 'rent':
                    return data.homeStatus === 'FOR_RENT';
                case 'sold':
                    return data.homeStatus?.includes('SOLD');
                case 'all':
                default:
                    return true;
            }
        },
        output: async (output, { data }) => {
            if (data.zpid && !isOverItems({ zpids, input })) {
                zpids.add(`${data.zpid}`);
                await Apify.pushData(output);
            }
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            zpids,
            minMaxDate,
            TYPES,
            fns,
            LABELS,
        },
    });

    return extendOutputFunction;
};

/**
 *
 * @param {{ simple: boolean }} input
 * @returns getSimpleResult function
 */
const getSimpleResultFunction = (input) => {
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
        responsivePhotos: true,
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

    return getSimpleResult;
};

module.exports = {
    validateInput,
    getInitializedStartUrls,
    initializePreLaunchHooks,
    getSimpleResultFunction,
    getExtendOutputFunction,
};
