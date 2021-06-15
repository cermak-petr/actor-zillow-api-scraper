const Apify = require('apify');
const {LABELS} = require("../constants");
const {log} = Apify.utils;
const {RetireError} = require('./init');


async function handleDetailCrawl(page, request, requestQueue, extendOutputFunction) {
    log.info(`Scraping ${page.url()}`);

    if (request.url.startsWith('/b/') || !+request.userData.zpid) {
        const nextData = await page.$eval('[id="__NEXT_DATA__"]', (s) => JSON.parse(s.innerHTML));

        if (!nextData) {
            throw 'Missing data';
        }

        // legacy layout, need re-enqueue
        const zpid = _.get(nextData, 'props.initialData.building.zpid');

        if (zpid) {
            const url = `https://www.zillow.com/homedetails/${zpid}_zpid/`;

            const rq = await requestQueue.addRequest({
                url,
                userData: {
                    label: LABELS.DETAIL,
                    zpid: +zpid,
                },
            }, {forefront: true});

            if (!rq.wasAlreadyPresent) {
                log.info(`Re-enqueueing ${url}`);
            }
            return;
        }

        throw 'ZPID not found in page';
    }

    const scripts = await page.$x('//script[contains(., "RenderQuery") and contains(., "apiCache")]');

    // await Apify.setValue(`${request.userData.zpid}--${Math.random()}`, await page.content(), { contentType: 'text/html' });

    if (!scripts.length) {
        throw new RetireError('Failed to load preloaded data scripts');
    }

    log.info(`Extracting data from ${request.url}`);
    let noScriptsFound = true;

    for (const script of scripts) {
        try {
            const loaded = JSON.parse(JSON.parse(await script.evaluate((s) => s.innerHTML)).apiCache);

            for (const key in loaded) { // eslint-disable-line
                if (key.includes('RenderQuery') && loaded[key].property) {
                    await extendOutputFunction(loaded[key].property, {
                        request,
                        page,
                        zpid: request.userData.zpid,
                    });

                    noScriptsFound = false;
                    break;
                }
            }
        } catch (e) {
            if (e.message.includes('Cannot read property')) {
                // this is a faulty extend output function
                log.error(`Your Extend Output Function errored:\n\n    ${e}\n\n`, {url: page.url()});
            }
            log.debug(e);
        }
    }

    if (noScriptsFound) {
        throw 'Failed to load preloaded data from page';
    }
}

module.exports = {
    RetireError,
    handleDetailCrawl
}
