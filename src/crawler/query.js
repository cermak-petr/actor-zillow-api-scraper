const Apify = require('apify');
const {log, sleep} = Apify.utils;
const {RetireError} = require('./init');
const {
    isEnoughItemsCollected,
    processZpid,
    queryRegionHomes,
    splitQueryState,
    quickHash,
} = require('../functions');
const _ = require('lodash');
const {LABELS} = require("../constants");

async function handleSearch(page, request) {
    log.info(`Searching for "${request.userData.term}"`);

    const text = '#search-box-input';
    const btn = 'button#search-icon';

    await Promise.all([
        page.waitForSelector(text),
        page.waitForSelector(btn),
    ]);

    await page.focus(text);
    await page.type(text, request.userData.term, {delay: 100});

    await sleep(3000);

    try {
        await Promise.all([
            page.waitForNavigation({timeout: 15000}),
            page.tap(btn),
        ]);
    } catch (e) {
        throw new RetireError('Search didn\'t redirect, retrying...')
    }

    if (!/(\/homes\/|_rb)/.test(page.url()) || page.url().includes('/_rb/')) {
        throw new RetireError(
            `Unexpected page address ${page.url()}, use a better keyword for ` +
            `searching or proper state or city name. Will retry...`
        )
    }

    if (await page.$('.captcha-container')) {
        throw new RetireError('Captcha found when searching, retrying...');
    }
}

async function handleQuery(page, request, dump, requestQueue, extendOutputFunction, input, zpids, queryZpid) {
    // Get initial searchState
    let qs = request.userData.queryState;
    let searchState;
    let shouldContinue = true;
    let anyErrors = false;

    try {
        const pageQs = await page.evaluate(() => {
            try {
                return JSON.parse(
                    document.querySelector(
                        'script[data-zrr-shared-data-key="mobileSearchPageStore"]',
                    ).innerHTML.slice(4, -3),
                );
            } catch (e) {
                return {};
            }
        });

        const results = _.get(pageQs, 'cat1.searchResults.listResults', []);

        for (const {zpid, detailUrl} of results) {
            await dump(zpid, results);

            if (zpid) {
                if (isEnoughItemsCollected(input.maxItems, zpids)) {
                    shouldContinue = false;
                    break;
                }
                anyErrors = await processZpid(
                    request, page, extendOutputFunction, queryZpid, requestQueue, zpid, detailUrl
                );
            }
        }

        if (shouldContinue) {
            qs = qs || pageQs.queryState;

            if (!qs) {
                throw 'Query state is empty';
            }

            log.debug('queryState', {qs});

            const result = await page.evaluate(
                queryRegionHomes,
                {
                    qs,
                    // use a special type so the query state that comes from the url
                    // doesn't get erased
                    type: request.userData.queryState ? 'qs' : input.type,
                },
            );

            log.debug('query', result.qs);

            searchState = JSON.parse(result.body);
            qs = result.qs;
        }
    } catch (e) {
        log.debug(e);
    }

    if (shouldContinue) {
        // Check mapResults
        const results = [
            ..._.get(
                searchState,
                'cat1.searchResults.mapResults',
                [],
            ),
            ..._.get(
                searchState,
                'cat1.searchResults.listResults',
                [],
            ),
        ];

        if (!results || !results.length) {
            throw new RetireError(`No map results at ${JSON.stringify(qs.mapBounds)}`);
        }

        log.info(`Searching homes at ${JSON.stringify(qs.mapBounds)}`);

        // Extract home data from mapResults
        const thr = input.splitThreshold || 500;

        if (results.length >= thr) {
            if (input.maxLevel && (request.userData.splitCount || 0) >= input.maxLevel) {
                log.info('Over max level');
            } else {
                // Split map and enqueue sub-rectangles
                const splitCount = (request.userData.splitCount || 0) + 1;
                const split = [
                    ...splitQueryState(qs),
                    ...splitQueryState(request.userData.queryState),
                ];

                for (const queryState of split) {
                    if (isEnoughItemsCollected(input.maxItems, zpids)) {
                        break;
                    }

                    const uniqueKey = quickHash(`${request.url}${splitCount}${JSON.stringify(queryState)}`);
                    log.debug('queryState', {queryState, uniqueKey});

                    await requestQueue.addRequest({
                        url: request.url,
                        userData: {
                            queryState,
                            label: LABELS.QUERY,
                            splitCount,
                        },
                        uniqueKey,
                    });
                }
            }
        }

        if (results.length > 0) {
            const extracted = () => {
                log.info(`Extracted total ${zpids.size}`);
            };
            const interval = setInterval(extracted, 10000);

            try {
                for (const {zpid, detailUrl} of results) {
                    await dump(zpid, results);

                    if (zpid) {
                        anyErrors = await processZpid(
                            request, page, extendOutputFunction, queryZpid, requestQueue, zpid, detailUrl
                        );

                        if (isEnoughItemsCollected(input.maxItems, zpids)) {
                            break; // optimize runtime
                        }
                    }
                }
            } finally {
                if (!anyErrors) {
                    extracted();
                }
                clearInterval(interval);
            }
        }
    }

    return anyErrors;
}

module.exports = {
    handleSearch,
    handleQuery,
}
