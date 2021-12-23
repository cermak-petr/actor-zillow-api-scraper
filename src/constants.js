/**
 * Request labels
 */
const LABELS = {
    QUERY: 'QUERY',
    INITIAL: 'INITIAL',
    DETAIL: 'DETAIL',
    SEARCH: 'SEARCH',
    ZPIDS: 'ZPIDS',
};

/**
 * Type of items to search
 */
const TYPES = {
    rent: 'rent',
    all: 'all',
    fsbo: 'fsbo',
    sale: 'sale',
    sold: 'sold',
    qs: 'qs',
};

const INITIAL_URL = 'https://www.zillow.com/homes/Los-Angeles_rb/';

module.exports = {
    LABELS,
    TYPES,
    INITIAL_URL,
};
