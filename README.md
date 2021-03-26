### Zillow Scraper

Zillow Scraper is an [Apify actor](https://apify.com/actors) for extracting data about homes from [Zillow.com](https://zillow.com). It allows you to search homes in any location and extract detailed information about each one. It is build on top of [Apify SDK](https://sdk.apify.com/) and you can run it both on [Apify platform](https://my.apify.com) and locally.

The way it works is by accesing Zillow's internal API and recursively splitting the map 4 ways to overcome the limit of 500 results per search. To limit the number of outputted results, you can set the maximum depth of the 4-way split zooms. This is done using the `maxLevel` attribute.

- [Input](#input)
- [Output](#output)
- [Map splitting](#map-splitting)
- [Compute units consumption](#compute-units-consumption)
- [Extend output function](#extend-output-function)

### Input

| Field | Type | Description | Default value
| ----- | ---- | ----------- | -------------|
| search | string | Query string to be searched on the site | `"Los Angeles"` |
| startUrls | array | List of [Request](https://sdk.apify.com/docs/api/request#docsNav) objects that will be deeply crawled. The URL can be any Zillow.com home list page | none |
| maxItems | number | Maximum number of pages that will be scraped | `200` |
| maxLevel | number | Maximum map splitting level | `20` |
| minDate | string | Minimum date of the results allowed (timestamp or date string) | none |
| simple | boolean | Toggle whether simplified results will be returned | `true` |
| extendOutputFunction | string | Function that takes Zillow home data object as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) | `async ({ item, data }) => { return item; }` |
| extendScraperFunction | string | Allows to add additional functionality to the scraper. More information in [Extend scraper function](#extend-scraper-function) | `async ({ item, data, customData, Apify }) => { }` |
| proxyConfiguration | object | Proxy settings of the run. If you have access to Apify proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage | `{ "useApifyProxy": true }`|

Either the `search` or `startUrls` atrribute has to be set.

### Output

Output is stored in a dataset. Each item is information about a home.
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
You can find example of a full result [here](https://pastebin.com/dRxuZmNQ).

### Map splitting

To overcome the limit of 500 results per page, the crawler uses Zillow's internal API to search for homes on a rectangular section of a map. If the number of results on the map is higher than 500, the map is split into 4 quadrants and zoomed. Each of these quadrants is searched for homes and can again contain 500 results (that means using 1 split, we've increased the total result limit to 2000). Unless the result count in the quadrant is less than 500 (no need to split anymore), the quadrant is split again and so on. To limit this behavior, you can set the `maxLevel` attribute. That way, the map will be split only a maximum of `maxLevel` times, even if the number of results is higher than 500.

### Compute units consumption

Keep in mind that it is much more efficient to run one longer scrape (at least one minute) than more shorter ones because of the startup time.

The average consumption is about **1 Compute unit per 2000 results** scraped.

### Extend output function

You can use this function to update the default output of this actor. This function gets Zillow internal home data object as an argument, so you can choose which other attributes you would like to add. The output from this function will get merged with the default output.

The internal home object contains huge amounts of data - [example](https://pastebin.com/AW9KKGJ4)
Any of these attributes can be added to the result object.

The return value of this function has to be an object!

You can use this function to achieve 3 different things:
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

This example will add a new field `schools`, remove the `photos` field and
omit the output if there's no `schools` information

### Extend Scraper function

You can add additional functionality directly inside the `handlePageFunction` of the scraper without modifying the existing code.
This function receives internal functions that can be used to enqueue, fetch or control the scraper.

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

### Epilogue

Thank you for trying my actor. If you have any feedback or  if you find any bug, please create an issue on the [Github page](https://github.com/cermak-petr/actor-zillow-api-scraper).
