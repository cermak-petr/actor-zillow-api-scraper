const Apify = require('apify');

// Create browser with unblocked proxy configuration
const getWorkingBrowser = async (url, lpOptions) => {
    for(let i = 0; i < 100; i++){
        const browser = await Apify.launchPuppeteer(Object.assign({
            apifyProxySession: 'ZILLOW_' + i
        }, lpOptions));
        const page = await browser.newPage();
        try{
            await page.goto('https://www.zillow.com/homedetails/810-Gramercy-Dr-Los-Angeles-CA-90005/20612043_zpid/');
            await page.close();
            return browser;
        }
        catch(e){
            console.log('Page load failed, creating new browser...');
            await page.close();
            await browser.close();
        }
    }
    return null;
};

// Intercept home data API request and extract it's QueryID
const interceptQueryId = page => new Promise(async(resolve, reject) => {
    let resolved = false;
    await page.setRequestInterception(true);
    page.on('request', r => {
        const url = r.url();
        if(url.includes('https://www.zillow.com/graphql')){
            const payload = r.postData();
            if(payload){
                const data = JSON.parse(payload);
                if(data.operationName === 'ForSaleDoubleScrollFullRenderQuery'){
                    //page.setRequestInterception(false);
                    resolved = true;
                    resolve(data.queryId);
                    //return;
                }
                else{console.log(data.operationName);}
            }
        }
        r.continue();
    });
    const url = 'https://www.zillow.com/los-angeles-ca/';
    try{
        await page.goto(url);
        await page.waitForSelector('a.list-card-link');
        await page.click('a.list-card-link');
    }
    catch(e){reject(e);}
    setTimeout(() => {if(!resolved){reject();}}, 50000);
});

// Try intercepting QueryID until it's received
const getSampleQueryId = async (lpOptions) => {
    const browser = await Apify.launchPuppeteer(lpOptions);
    for(let i = 0; i < 100; i++){
        const page = await browser.newPage();
        try{
            const result = await interceptQueryId(page);
            await page.close();
            await browser.close();
            return result;
        }
        catch(e){
            console.log('Initial settings extraction in progress...');
            await Apify.setValue('queryid-error.html', await page.content(), {contentType: 'text/html'});
            await page.close();
        }
    }
};

// Extract inital queryState from page
const getInitialQueryState = () => {
    const scriptText = document.querySelector('script[data-zrr-shared-data-key="mobileSearchPageStore"]').textContent;
    const jsonText = scriptText.slice(4, scriptText.length - 3);
    return JSON.parse(jsonText).queryState;
};

// Split map into 4 sub-rectangles
const splitQueryState = queryState => {
    const qs = queryState;
    const mb = qs.mapBounds;
    const states = [{...qs}, {...qs}, {...qs}, {...qs}];
    states.forEach(state => {state.mapBounds = {...mb};});
    states[0].mapBounds.south = (mb.south + mb.north)/2;
    states[0].mapBounds.east = (mb.east + mb.west)/2;
    states[1].mapBounds.south = (mb.south + mb.north)/2;
    states[1].mapBounds.west = (mb.east + mb.west)/2;
    states[2].mapBounds.north = (mb.south + mb.north)/2;
    states[2].mapBounds.east = (mb.east + mb.west)/2;
    states[3].mapBounds.north = (mb.south + mb.north)/2;
    states[3].mapBounds.west = (mb.east + mb.west)/2;
    states.forEach(state => {if(mb.mapZoom){state.mapZoom = mb.mapZoom + 1;}});
    return states;
};

// Make API query for all ZPIDs in map reqion
const queryRegionHomes = async queryState => {
    const qsParam = encodeURIComponent(JSON.stringify(queryState));
    const resp = await fetch('https://www.zillow.com/search/GetSearchPageState.htm?searchQueryState=' + qsParam);
    return await resp.json();
};

// Make API query for home data by ZPID
const queryZpid = async (zpid, queryId) => {
    const resp = await fetch(`https://www.zillow.com/graphql/?zpid=${zpid}&contactFormRenderParameter=&queryId=${queryId}&operationName=ForSaleDoubleScrollFullRenderQuery`, {
        method: 'POST', 
        body: JSON.stringify({
            "operationName": "ForSaleDoubleScrollFullRenderQuery",
            "variables": {
                "zpid": zpid,
                "contactFormRenderParameter": {
                    "zpid": zpid,
                    "platform": "desktop",
                    "isDoubleScroll": true
                }
            },
            //"clientVersion": "home-details/6.0.11.139.master.dbc9d82",
            "queryId": queryId
        }), 
        headers: {
            'accept': '*/*',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'cs,en-US;q=0.9,en;q=0.8,de;q=0.7,es;q=0.6',
            'content-length': 276,
            'content-type': 'text/plain',
            'origin': 'https://www.zillow.com',
            'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ubuntu Chromium/74.0.3729.169 Chrome/74.0.3729.169 Safari/537.36'
        }
    });
    return resp.json();
};

// Allowed home data attributes
let attributes = {"datePosted":true,"isZillowOwned":true,"priceHistory":true,"zpid":true,"homeStatus":true,"address":true,"bedrooms":true,"bathrooms":true,"price":true,"yearBuilt":true,"isPremierBuilder":true,"longitude":true,"latitude":true,"description":true,"primaryPublicVideo":true,"tourViewCount":true,"postingContact":true,"unassistedShowing":true,"livingArea":true,"currency":true,"homeType":true,"comingSoonOnMarketDate":true,"timeZone":true,"hdpUrl":true,"newConstructionType":true,"moveInReady":true,"moveInCompletionDate":true,"hugePhotos":true,"lastSoldPrice":true,"contingentListingType":true,"zestimate":true,"zestimateLowPercent":true,"zestimateHighPercent":true,"rentZestimate":true,"restimateLowPercent":true,"restimateHighPercent":true,"solarPotential":true,"brokerId":true,"parcelId":true,"homeFacts":true,"taxAssessedValue":true,"taxAssessedYear":true,"isPreforeclosureAuction":true,"listingProvider":true,"marketingName":true,"building":true,"priceChange":true,"datePriceChanged":true,"dateSold":true,"lotSize":true,"hoaFee":true,"mortgageRates":true,"propertyTaxRate":true,"whatILove":true,"isFeatured":true,"isListedByOwner":true,"isCommunityPillar":true,"pageViewCount":true,"favoriteCount":true,"openHouseSchedule":true,"brokerageName":true,"taxHistory":true,"abbreviatedAddress":true,"ownerAccount":true,"isRecentStatusChange":true,"isNonOwnerOccupied":true,"buildingId":true,"daysOnZillow":true,"rentalApplicationsAcceptedType":true,"buildingPermits":true,"highlights":true,"tourEligibility":true};

// Simplify received home data
const getSimpleResult = (data) => {
    const result = {};
    for(const key in attributes){
        if(data[key]){result[key] = data[key];}
    }
    if(result.hugePhotos){
        result.photos = result.hugePhotos.map(hp => {return {url: hp.url}});
        delete result.hugePhotos;
    }
    return result;
};

Apify.main(async () => {
    // Initialize input and state of the actor
    const input = await Apify.getInput();
    const state = await Apify.getValue('STATE') || {
        extractedZpids: {},
        resultCount: 0
    };
    Apify.events.on('migrating', data => Apify.setValue('STATE', state));

    // Check input
    if(!(input.search && input.search.trim().length > 0) && !input.startUrls){
        throw new Error('Either "search" or "startUrls" attribute has to be set!');
    }

    // Create launchPuppeteerOptions
    const lpOptions = input.proxyConfiguration || {useApifyProxy: true};
    Object.assign(lpOptions, {
        useChrome: true,
        stealth: true
    });

    // Parse extendOutpudFunction
    let extendOutputFunction = null;
    if(input.extendOutputFunction){
        try{extendOutputFunction = eval(input.extendOutputFunction);}
        catch(e){throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);}
        if(typeof extendOutputFunction !== "function"){
            throw new Error(`extendOutputFunction is not a function! Please fix it or use just default output!`)
        }
    }

    // Toggle showing only a subset of result attriutes
    if(input.simple){
        attributes = {"address":true,"bedrooms":true,"bathrooms":true,"price":true,"yearBuilt":true,"longitude":true,"latitude":true,"description":true,"livingArea":true,"currency":true,"hdpUrl":true,"hugePhotos":true};
    }

    // Intercept sample QueryID
    console.log('Extracting initial settings...');
    const queryId = await getSampleQueryId(lpOptions);
    console.log('Initial settings extracted.');

    // Create RequestQueue
    const requestQueue = await Apify.openRequestQueue();
    if(input.search){
        const term = encodeURIComponent(input.search.trim());
        await requestQueue.addRequest({
            url: 'https://www.zillow.com/homes/' + term
        });
    }
    if(input.startUrls){
        for(const sUrl of input.startUrls){
            const request = (typeof sUrl === 'string') ? {url: sUrl} : sUrl;
            if(!request.url || (typeof request.url !== 'string')){
                throw new Error('Invalid startUrl: ' + JSON.stringify(sUrl));
            }
            await requestQueue.addRequest(request);
        }
    }

    // Create crawler
    const crawler = new Apify.PuppeteerCrawler({
        requestQueue,

        maxRequestRetries: 10,

        handlePageTimeoutSecs: 600,

        launchPuppeteerOptions: lpOptions,

        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            // Retire browser if captcha is found
            if(await page.$('.captcha-container')){
                await puppeteerPool.retire(page.browser());
                throw 'Captcha found, retrying...';
            }

            // Get initial searchState
            let qs = request.userData.queryState;
            try{
                if(!qs){qs = await page.evaluate(getInitialQueryState);}
                const searchState = await page.evaluate(queryRegionHomes, qs);
            }
            catch(e){
                await puppeteerPool.retire(page.browser());
                throw 'Unable to get searchState, retrying...';
            }
            
            // Check mapResults
            const mapResults = searchState.searchResults.mapResults;
            console.log('Searching homes at ' + JSON.stringify(qs.mapBounds));
            if(!mapResults){throw 'No map results at ' + JSON.stringify(qs.mapBounds);}

            // Extract home data from mapResults
            if(mapResults.length < 500 || (input.maxLevel && (request.userData.splitCount || 0) >= input.maxLevel)){
                console.log('Found ' + mapResults.length + ' homes, extracting data...');
                const start = request.userData.start || 0;
                if(start){console.log('Starting at ' + start);}
                for(let i = start; i < mapResults.length; i++){
                    const home = mapResults[i];
                    if(home.zpid && !state.extractedZpids[home.zpid]){
                        try{
                            const homeData = await page.evaluate(queryZpid, home.zpid, queryId);
                            const result = getSimpleResult(homeData.data.property);
                            if(extendOutputFunction){
                                Object.assign(result, await extendOutputFunction(homeData.data));
                            }
                            await Apify.pushData(result);
                            state.extractedZpids[home.zpid] = true;
                            if(input.maxItems && ++state.resultCount >= input.maxItems){
                                return process.exit(0);
                            }
                        }
                        catch(e){
                            console.log('Data extraction failed - zpid: ' + home.zpid);
                            await puppeteerPool.retire(page.browser());
                            await requestQueue.addRequest({
                                url: request.url,
                                uniqueKey: Math.random() + '',
                                userData: Object.assign(request.userData, {start: i})
                            });
                            return;
                        }
                    }
                }
            }
            // Split map and enqueue sub-rectangles
            else{
                console.log('Found more than 500 homes, splitting map...');
                const states = splitQueryState(qs);
                for(const state of states){
                    await requestQueue.addRequest({
                        url: 'https://www.zillow.com/homes/Los-Angeles,-CA_rb/',
                        userData: {
                            queryState: state,
                            splitCount: (request.userData.splitCount || 0) + 1
                        },
                        uniqueKey: Math.random() + ''
                    });
                }
            }
        },
        handleFailedRequestFunction: async ({ request }) => {
            // This function is called when the crawling of a request failed too many times
            console.log('Request ' + request.url + ' failed too many times.');
        },
    });

    // Start crawling
    await crawler.run();

});
