/**
 * Request labels
 */
const LABELS = {
    QUERY: 'QUERY',
    INITIAL: 'INITIAL',
    DETAIL: 'DETAIL',
    SEARCH: 'SEARCH',
    ZPIDS: 'ZPIDS',
    ENRICHED_ZPIDS: 'ENRICHED_ZPIDS',
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

const PAGES_LIMIT = 20;

const URL_PATTERNS_TO_BLOCK = [
    '.gif',
    '.webp',
    '.jpeg',
    '.jpg',
    '.png',
    '.ttf',
    '.woff',
    '.woff2',
    '.css.map',
    'www.googletagmanager.com',
    'www.googletagservices.com',
    'www.googleadservices.com',
    'www.google-analytics.com',
    'sb.scorecardresearch.com',
    'cdn.ampproject.org',
    'facebook.net',
    'facebook.com',
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
    'tealiumiq.com',
    'pdst-events-prod-sink',
    'doubleclick.net',
    'ct.pinterest.com',
    'ipredictive.com',
    'adservice.google.com',
    'adsrvr.org',
    'pubmatic.com',
    'sentry-cdn.com',
    'demdex.net',
    'mathtag.com',
    'api.rlcdn.com',
    'clarity.ms',
];

const ORIGIN = 'https://www.zillow.com/';

/**
 * @typedef {{
 *   zpid: string
 *   detailUrl: string
 *   relaxed: boolean
 * }} ZpidResult
 *
 * @typedef {{
 *     searchResults: {
 *       mapResults: ZpidResult[]
 *       listResults: ZpidResult[]
 *       relaxedResults: ZpidResult[]
 *     },
 *     searchList: {
 *       listResultsTitle: string,
 *       zeroResultsFilters?: Record<string, number>
 *     }
 * }} GetSearchPageStateResults
 *
 * @typedef {{
 *   totalResultCount: number
 * }} GetSearchPageStateCount
 *
 * @typedef {{
 *   cat1?: GetSearchPageStateResults,
 *   cat2?: GetSearchPageStateResults,
 *   categoryTotals: {
 *      [index: string]: GetSearchPageStateCount,
 *      cat1: GetSearchPageStateCount,
 *      cat2: GetSearchPageStateCount,
 *   }
 * }} GetSearchPageState
 *
 * @typedef {{
 *    pagination: { currentPage?: number },
 *    mapBounds: {
 *      west: number,
 *      east: number,
 *      south: number,
 *      north: number,
 *    },
 *    mapZoom?: number,
 *    filterState: Record<string, any>
 * }} SearchQueryState
 *
 * @typedef {{
 *   search?: string
 *   zipcodes?: string[]
 *   startUrls?: any[]
 *   type?: string
 *   zpids?: string[]
 * }} Input
 */

module.exports = {
    LABELS,
    TYPES,
    INITIAL_URL,
    PAGES_LIMIT,
    URL_PATTERNS_TO_BLOCK,
    ORIGIN,
};
