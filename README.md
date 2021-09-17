## Features

Our free Zillow Real Estate Scraper lets you extract data from real estate listings on [Zillow.com](https://zillow.com). It enables you to search properties in any location and extract detailed information, such as full addresses, longitude, latitude, price, description, URL, photos, number of bedrooms and bathrooms, and all other information available.

## Why scrape Zillow?
Zillow has over 110 million properties in its database, more than 245 million monthly unique visitors, and 80% of all homes in the United States have been viewed on the website. 

So what could you do with all that real estate listings data?

- Use the data to add value to your real estate business by providing extra information to your visitors.
- Extract business intelligence to predict the future of the real estate market, track demographic changes, and identify popular new neighborhoods.
- Make smarter investment decisions by ensuring that you understand how the market is changing.
- Automate real estate agency lead generation and make sure that you can find, and keep, the right clients in the long term.
- Find new ways to provide tech services to real estate agencies and local listings agencies.
- Train AI models to predict future trends and act fast when opportuities arise.

These are just some ideas to get you thinking about how web scraping can give you the data you need. Check out our dedicated [Real Estate page](https://apify.com/industries/real-estate) for more inspiration.

## Tutorial and further reading
Check out our [step-by-step guide](https://blog.apify.com/step-by-step-guide-to-scraping-zillow/) to using the Zillow Real Estate Scraper and you'll be scraping listings in no time! Or read about how [web scraping is revolutionizing](https://blog.apify.com/how-web-scraping-is-revolutionizing-the-real-estate-business-9888ea8d0beb/) the real estate business.

## What about the Zillow API?
Zillow has a [great API](https://www.zillow.com/howto/api/APIOverview.htm), but it does impose some restrictions on users, such as the number of API calls per page at the same time. This scraper actually uses the Zillow API, but it recursively splits the map four ways to overcome the limits per search. To limit the number of results, you can set the maximum depth of the four-way split zooms. This is done using the `maxLevel` attribute.

## Cost of usage
The average cost of using the Zillow Scraper is about **$0.25 for every 2,000 results** scraped.

Note that it is much more efficient to run one longer scrape (at least one minute) than more shorter ones because of the startup time.

## Input
| Field | Type | Description | Default value
| ----- | ---- | ----------- | -------------|
| search | string | Query string to be searched | `"Los Angeles"` |
| startUrls | array | List of [request](https://sdk.apify.com/docs/api/request#docsNav) objects that will be deeply crawled. The URL can be any Zillow.com home listing page. | none |
| maxItems | number | Maximum number of pages that will be scraped | `200` |
| maxLevel | number | Maximum map splitting level | `20` |
| minDate | string | Minimum date of the results allowed (timestamp or date string) | none |
| simple | boolean | Toggle whether simplified results will be returned | `true` |
| extendOutputFunction | string | Function that takes Zillow home data object as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) | `async ({ item, data }) => { return item; }` |
| extendScraperFunction | string | Allows you to add additional functionality to the scraper. More details in [Extend scraper function](#extend-scraper-function) | `async ({ item, data, customData, Apify }) => { }` |
| proxyConfiguration | object | Proxy settings of the run. If you have access to Apify proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage | `{ "useApifyProxy": true }`|

Either the `search` or `startUrls` atrribute has to be set.

## Output
Output is stored in a dataset. Each item is information about a property home.
If the `simple` attribute is set, an example result may look like this:

```jsonc
{
  "address": {
    "streetAddress": "20349 Valerio St",
    "city": "Winnetka",
    "state": "CA",
    "zipcode": "91306",
    "neighborhood": null,
    "community": null,
    "subdivision": null
  },
  "bedrooms": 4,
  "bathrooms": 3,
  "price": 748900,
  "yearBuilt": 1970,
  "longitude": -118.57711791992188,
  "homeStatus": "FOR_SALE",
  "latitude": 34.20491409301758,
  "description": "This wonderful 4 bedroom, 3 bathroom home nestled in Winnetka offers over 2,300 sq ft of space. The front door opens to vaulted ceilings and handsome wood flooring. Around the corner an eye-catching fireplace provides welcome warmth on those colder nights, flanked by dual windows which supply great natural sunlight. The family room is an entertainer's dream, complete with high ceilings, a skylight, and a swing-out bar that fits neatly into its enclave when not in use. In the kitchen you'll find stylish granite countertops, dark wood cabinetry, and a decorative tile backsplash. This spacious room serves as the perfect setting for cooking up delicious dishes. Plus, a handy garden window is ideal for flexing your green thumb. The primary bedroom includes an impressive walk-in closet, while its corresponding bathroom exudes elegance and a refined taste. In the backyard you'll find a covered patio and a flowerbed, complemented by high walls for privacy. Lastly, enjoy the large 2-car garage with convenient washer and dryer hookups.",
  "livingArea": 2314,
  "currency": "USD",
  "url": "https://www.zillow.com/homedetails/20349-Valerio-St-Winnetka-CA-91306/19912555_zpid/",
  "photos": [
    "https://photos.zillowstatic.com/fp/f911e9dcb1d4ab7761b410c5e16870fa-p_f.jpg",
    // ...
  ]
}
```

If the `simple` attribute is not set, the result will contain many more attributes.
You can find an example of a full result [here](https://pastebin.com/dRxuZmNQ).

### Map splitting
To overcome the Zillow API limits of 1,000 calls per day and 20 calls per page, the scraper uses Zillow's internal API to search for homes on a rectangular section of a map. 

*Note that the limit at the time of creating this actor was 500 results per page, so the calculations below are based on that figure.* 

If the number of results on the map is higher than 500, the map is split into four quadrants and zoomed. Each of these quadrants is searched for homes and can again contain 500 results (that means using 1 split, we've increased the total result limit to 2,000). Unless the result count in the quadrant is less than 500 (no need to split anymore), the quadrant is split again and so on. To limit this behavior, you can set the `maxLevel` attribute. That way, the map will be split only a maximum of `maxLevel` times, even if the number of results is higher than 500.

### Extend output function
You can use this function to update the default output of this actor. This function gets Zillow internal home data object as an argument, so you can choose which other attributes you would like to add. The output from this function will get merged with the default output.

The internal home object contains huge amounts of data - here's an [example](https://pastebin.com/AW9KKGJ4).

Any of these attributes can be added to the result object.

The return value of this function has to be an object!

You can use this function to achieve three different things:
- Add a new field - Return object with a field that is not in the default output
- Change a field - Return an existing field with a new value
- Remove a field - Return an existing field with a value `undefined`

```js
async ({ item, data }) => {
  if (!data.schools || !data.schools.length) {
    return null; // omit output
  }

  item.schools = data.schools; // add new array data
  item.photos = undefined; // remove the photos array from the output, making it CSV friendly
  delete item.photos; // works as well

  return item; // need to return the item here, otherwise your dataset willbe empty
}
```

This example will add a new field `schools`, remove the `photos` field, and
omit the output if there's no `schools` information

### Extend Scraper function
You can add additional functionality directly inside the `handlePageFunction` of the scraper without modifying the existing code. This function receives internal functions that can be used to enqueue, fetch, or control the scraper.

```js
async ({ state, request, requestQueue, Apify, LABELS, TYPES, processZpids, queryRegionHomes, customData }) => {
    // returning something here is no-op
    if (request.userData.label === LABELS.INITIAL) {
        await requestQueue.addRequest({
            url: customData.zillowUrl,
            userData: {
                label: LABELS.DETAIL,
            }
        })
    }
}
```

## Changelog
Zillow Real Estate Scraper is actively maintained and regularly updated. You can always find the latest fixes and changes in the [changelog](https://github.com/cermak-petr/actor-zillow-api-scraper/blob/master/CHANGELOG.md).
