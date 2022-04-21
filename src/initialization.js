const Apify = require('apify');
const { TYPES, LABELS, ORIGIN, Input } = require('./constants');

const fns = require('./functions');

const { utils: { log } } = Apify;

const {
    getUrlData,
    extendFunction,
    // eslint-disable-next-line no-unused-vars
    createGetSimpleResult,
} = fns;

/**
 * Throws error if the provided input is invalid.
 * @param {{ search: String, startUrls: any[], zpids: any[], zipcodes: any[], maxLevel: number }} input
 */
const validateInput = (input) => {
    if (!(input.search && input.search.trim().length > 0)
        && !(input.startUrls?.length)
        && !(input.zpids?.length)
        && !(input.zipcodes?.length)
    ) {
        throw new Error('Either "search", "startUrls", "zipcodes" or "zpids" attribute has to be set!');
    }

    if (input.maxLevel >= 2) {
        log.warning(`\n===========================\n\n\n\nYou're using "Max zoom level" with a value of ${input.maxLevel}. The usual setting should be 1 or 0. Keeping this setting can take a very long time to complete.\n\n\n\n===========================`);
    }
};

/**
 * Removes pagination for given URL
 * @param {string} url
 */
const cleanUpUrl = (url) => {
    const nUrl = new URL(url, ORIGIN);
    /** @type {import('./constants').SearchQueryState | null} */
    let searchQueryState = null;

    // pagination on the JSON variable
    if (nUrl.searchParams.has('searchQueryState')) {
        try {
            searchQueryState = JSON.parse(nUrl.searchParams.get('searchQueryState'));

            nUrl.searchParams.set('searchQueryState', JSON.stringify({
                ...searchQueryState,
                pagination: {}, // erase the pagination
            }));
        } catch (e) {
            throw new Error(`The URL ${url} don't have a valid searchQueryState parameter:\n${e.message}`);
        }
    }

    nUrl.pathname = '/homes/';

    return {
        url: nUrl,
        searchQueryState,
    };
};

/**
 * Lazy load the RequestQueue. Can take a while depending of the number
 * of URLs from input and the handlePageFunction might timeout
 *
 * @param {Input} input
 * @param {Apify.RequestQueue} rq
 */
const getInitializedStartUrls = (input, rq) => async () => {
    if (input.search?.trim()) {
        const terms = new Set(
            input.search
                .split(/(\n|\r\n)/m)
                .map((s) => s.trim())
                .filter(Boolean),
        );

        if (!terms.size) {
            throw new Error('You need to provide a region for search, one per line');
        }

        for (const term of terms) {
            const result = await rq.addRequest({
                url: 'https://www.zillow.com',
                uniqueKey: `${term}`,
                userData: {
                    label: LABELS.SEARCH,
                    term,
                },
            });

            if (!result.wasAlreadyPresent) {
                log.info(`Added search ${term}`);
            }
        }
    }

    if (input.startUrls?.length) {
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

            const userData = getUrlData(req.url);
            const { url, searchQueryState } = cleanUpUrl(req.url);

            const uniqueKey = (() => {
                if (searchQueryState) {
                    return fns.getUniqueKeyFromQueryState(searchQueryState);
                }

                if (userData.zpid) {
                    return userData.zpid;
                }

                return url.toString();
            })();

            await rq.addRequest({
                url: url.toString(),
                userData,
                headers: [
                    LABELS.ENRICHED_ZPIDS,
                    LABELS.QUERY,
                    LABELS.ZPIDS,
                    LABELS.DETAIL,
                ].includes(userData.label) ? {
                        referer: ORIGIN,
                    } : {},
                uniqueKey,
            });
        }
    }

    if (input.zpids?.length) {
        const zpids = Array.from(new Set(input.zpids.map(fns.normalizeZpid).filter(Boolean)));

        if (!zpids.length) {
            log.warning(`"zpids" array option was provided, but no valid zpid found out of ${input.zpids.length} items`);
            return;
        }

        log.info(`Added ${zpids.length} zpids from input`);

        await rq.addRequest({
            url: 'https://www.zillow.com/',
            uniqueKey: 'ZPIDS',
            userData: {
                label: LABELS.ZPIDS,
                zpids,
            },
        }, { forefront: true });
    }

    if (input.zipcodes?.length) {
        log.info(`Trying to add ${input.zipcodes.length} zipcodes`);
        let count = 0;

        for (const zipcode of input.zipcodes) {
            // simple regex for testing the 5 digit zipcodes
            if (/^(?!0{3})[0-9]{3,5}$/.test(zipcode)) {
                const cleanZip = `${zipcode}`.replace(/[^\d]+/g, '');

                const result = await rq.addRequest({
                    url: `https://www.zillow.com/homes/${cleanZip}_rb/`,
                    uniqueKey: `ZIP${cleanZip}`,
                    userData: {
                        label: LABELS.QUERY,
                        zipcode: cleanZip,
                    },
                });

                if (!result.wasAlreadyPresent) {
                    count++;
                }
            } else {
                throw new Error(`Invalid zipcode provided: ${zipcode}`);
            }
        }

        log.info(`Added ${count} zipcodes`);
    }
};

/**
 *
 * @param {{ debugLog: boolean, handlePageTimeoutSecs: any}} input
 * @returns initialized preLaunchHooks
 */
const initializePreLaunchHooks = (input) => {
    return [async (/** @type {any} */ _pageId, /** @type {{ launchOptions: any; }} */ launchContext) => {
        launchContext.launchOptions = {
            ...launchContext.launchOptions,
            bypassCSP: true,
            ignoreHTTPSErrors: true,
            devtools: input.debugLog,
            headless: false,
        };
    }];
};

/**
 *
 * @param {{
 *  zpidsHandler: fns.ZpidHandler,
 *  input: {
 *      rawOutput: boolean,
 *      type: string,
 *  },
 * }} globalContext
 * @param {*} minMaxDate
 * @param {ReturnType<createGetSimpleResult>} getSimpleResult
 */
const getExtendOutputFunction = async ({ zpidsHandler, input }, minMaxDate, getSimpleResult) => {
    const extendOutputFunction = await extendFunction({
        map: async (data) => {
            if (input.rawOutput === true) {
                return data;
            }

            return getSimpleResult(data);
        },
        filter: async ({ data }) => {
            if (zpidsHandler.isOverItems()) {
                return false;
            }

            if (!data?.zpid) {
                return false;
            }

            if (zpidsHandler.has(data.zpid)) {
                return false;
            }

            if (minMaxDate.isComparable && data.datePostedString) {
                if (!minMaxDate.compare(data.datePostedString)) {
                    return false;
                }
            }

            switch (input.type) {
                case 'sale':
                    return data.homeStatus === 'FOR_SALE';
                case 'fsbo':
                    return data.homeStatus === 'FOR_SALE' && data.keystoneHomeStatus === 'ForSaleByOwner';
                case 'rent':
                    return data.homeStatus === 'FOR_RENT';
                case 'sold':
                    return data.homeStatus?.includes('SOLD') === true;
                case 'all':
                default:
                    return true;
            }
        },
        output: async (output, { data }) => {
            if (!zpidsHandler.isOverItems() && zpidsHandler.add(data.zpid)) {
                await Apify.pushData(output);
            }
        },
        input,
        key: 'extendOutputFunction',
        helpers: {
            getUrlData,
            getSimpleResult,
            zpidsHandler,
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
        zpid: true,
        address: true,
        bedrooms: true,
        bathrooms: true,
        price: true,
        yearBuilt: true,
        longitude: true,
        latitude: true,
        homeStatus: true,
        description: true,
        livingArea: true,
        currency: true,
        hdpUrl: true,
        homeType: true,
        dateSold: true,
        dateSoldString: true,
        datePostedString: true,
        datePosted: true,
        responsivePhotos: true,
        daysOnZillow: true,
    };

    const getSimpleResult = createGetSimpleResult(
        input.simple
            ? simpleResult
            : {
                ...simpleResult,
                isZillowOwned: true,
                priceHistory: true,
                isPremierBuilder: true,
                primaryPublicVideo: true,
                tourViewCount: true,
                postingContact: true,
                unassistedShowing: true,
                comingSoonOnMarketDate: true,
                timeZone: true,
                newConstructionType: true,
                moveInReady: true,
                moveInCompletionDate: true,
                lastSoldPrice: true,
                contingentListingType: true,
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
