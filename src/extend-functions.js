const Apify = require('apify');
const _ = require('lodash');
const { TYPES, LABELS } = require('./constants');

const fns = require('./functions');

const {
    getUrlData,
    extendFunction,
    isOverItems,
    // eslint-disable-next-line no-unused-vars
    createGetSimpleResult,
} = fns;

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

            if (!_.get(data, 'zpid')) {
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
            _,
            zpids,
            minMaxDate,
            TYPES,
            fns,
            LABELS,
        },
    });

    return extendOutputFunction;
};

module.exports = {
    getExtendOutputFunction,
};
