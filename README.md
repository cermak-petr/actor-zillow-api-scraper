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
| extendOutputFunction | string | Function that takes Zillow home data object ($) as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) | `(data) => { return {}; }` |
| proxyConfiguration | object | Proxy settings of the run. If you have access to Apify proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage | `{ "useApifyProxy": true }`|  

Either the `search` or `startUrls` atrribute has to be set.

### Output

Output is stored in a dataset. Each item is information about a home.
If the `simple` attribute is set, an example result may look like this:
```
{
  "address": {
    "streetAddress": "312 N Kendall Ave APT B",
    "city": "Kalamazoo",
    "state": "MI",
    "zipcode": "49006",
    "neighborhood": "Westwood",
    "community": null,
    "subdivision": null
  },
  "bedrooms": 6,
  "bathrooms": 3.5,
  "price": 300,
  "longitude": -85.626183,
  "latitude": 42.29457,
  "description": "Rent: $300.00/bed Student Housing. This is a 3-unit complex within close proximity to WMU consisting of 6 bedrooms and 3.5 baths throughout three levels in each unit. The main level features 1 of the 6 bedrooms, 1/2 bath, a roomy living room, kitchen with an eating area, and entry to your private deck. The upper level features 3 bedrooms, 2 full baths and a laundry area with a full size washer and dryer. The lower level features 2 bedrooms, 1 full bath and a bonus 2nd living area to use for socializing, gaming, studying, etc. All bedrooms are good-size and privately keyed. trash, lawn and snow plowing services included. Pet friendly with prior management approval and pet rent. Cats Allowed\nOven\nParking\nResident Pays Electricity\nResident Pays Gas\nResident Pays Water\nSmall Dogs Allowed\nSmoke Free\nTrash Pick Up Included\nUnfurnished\nWasher & Dryer",
  "livingArea": 2236,
  "currency": "USD",
  "url": "https://www.zillow.com/homedetails/312-N-Kendall-Ave-APT-B-Kalamazoo-MI-49006/2096316908_zpid/",
  "photos": [
    "https://photos.zillowstatic.com/p_f/IS3f0lgq5a0cxn0000000000.jpg",
    "https://photos.zillowstatic.com/p_f/ISzvuwdfl85g7p0000000000.jpg",
    "https://photos.zillowstatic.com/p_f/ISrpskv8h0xi7p0000000000.jpg",
    "https://photos.zillowstatic.com/p_f/ISjjq8d2dsol7p0000000000.jpg",
    "https://photos.zillowstatic.com/p_f/ISbdowuv8kgo7p0000000000.jpg",
    "https://photos.zillowstatic.com/p_f/IS3zfi07y70jap0000000000.jpg"
  ]
}
```
If the `simple` attribute is not set, the result will contain many more attributes.
You can find example of a full result [here](https://pastebin.com/P016j7ip).

### Map splitting
To overcome the limit of 500 results per page, the crawler uses Zillow's internal API to search for homes on a rectangular section of a map. If the number of results on the map is higher than 500, the map is split into 4 quadrants and zoomed. Each of these quadrants is searched for homes and can again contain 500 results (that means using 1 split, we've increased the total result limit to 2000). Unless the result count in the quadrant is less than 500 (no need to split anymore), the quadrant is split again and so on. To limit this behavior, you can set the `maxLevel` attribute. That way, the map will be split only a maximum of `maxLevel` times, even if the number of results is higher than 500.

### Compute units consumption
Keep in mind that it is much more efficient to run one longer scrape (at least one minute) than more shorter ones because of the startup time.

The average consumption is about **1 Compute unit per 2000 results** scraped.

### Extend output function

You can use this function to update the default output of this actor. This function gets Zillow internal home data object as an argument, so you can choose which other attributes you would like to add. The output from this function will get merged with the default output.
  
The internal home object contains huge amounts of data - [example](https://pastebin.com/kiWayJvs)  
Any of these attributes can be added to the result object.

The return value of this function has to be an object!

You can return fields to achieve 3 different things:
- Add a new field - Return object with a field that is not in the default output
- Change a field - Return an existing field with a new value
- Remove a field - Return an existing field with a value `undefined`

```
(data) => {
    return {
        schools: data.property.schools,
        homeStatus: 'SOLD',
        address: undefined,
    }
}
```
This example will add a new field `schools`, change the `homeStatus` field and remove the `address` field

### Epilogue
Thank you for trying my actor. You can send any feedback you have to my email `cermak.petr6@gmail.com`.  
If you find any bug, please create an issue on the [Github page](https://github.com/cermak-petr/actor-zillow-api-scraper).
