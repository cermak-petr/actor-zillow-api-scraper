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

const RESULTS_LIMIT = 500;
const PAGES_LIMIT = 20;

const URL_PATTERNS_TO_BLOCK = [
    '.gif',
    '.webp',
    '.jpeg',
    '.jpg',
    '.png',
    '.ttf',
    '.css.map',
    'www.googletagmanager.com',
    'www.googletagservices.com',
    'www.googleadservices.com',
    'www.google-analytics.com',
    'sb.scorecardresearch.com',
    'cdn.ampproject.org',
    'doubleclick.net',
    'pagead2.googlesyndication.com',
    'amazon-adsystem.com',
    'tpc.googlesyndication.com',
    'googleads.g.doubleclick.net',
    'pxl.jivox.com',
    'ib.adnxs.com',
    'static.ads-twitter.com',
    'bat.bing.com',
    'px-cloud.net',
    'fonts.gstatic.com',
    'tiqcdn.com',
    'fonts.googleapis.com',
    'photos.zillowstatic.com',
    'survata.com',
    'zg-api.com',
    'accounts.google.com',
    'casalemedia.com',
    'adsystem.com',
    '/collector',
    'tapad.com',
    'cdn.pdst.fm',
    'pdst-events-prod-sink',
    'doubleclick.net',
    'ct.pinterest.com',
    'sync.ipredictive.com',
    'adservice.google.com',
    'adsrvr.org',
    'pubmatic.com',
    'sentry-cdn.com',
    'api.rlcdn.com',
];

module.exports = {
    LABELS,
    TYPES,
    INITIAL_URL,
    RESULTS_LIMIT,
    PAGES_LIMIT,
    URL_PATTERNS_TO_BLOCK,
};
