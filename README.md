### Zillow Scraper

Zillow Scraper is an [Apify actor](https://apify.com/actors) for extracting data about homes from [Zillow.com](https://zillow.com). It allows you to search homes in any location and extract detailed information about each one. It is build on top of [Apify SDK](https://sdk.apify.com/) and you can run it both on [Apify platform](https://my.apify.com) and locally.  
  
The way it works is by accesing Zillow's internal API and recursively splitting the map 4 ways to overcome the limit of 500 results per search. To limit the number of outputted results, you can set the maximum depth of the 4-way split zooms. This is done using the `maxLevel` attribute.

- [Input](#input)
- [Output](#output)
- [Compute units consumption](#compute-units-consumption)
- [Extend output function](#extend-output-function)

### Input

| Field | Type | Description | Default value
| ----- | ---- | ----------- | -------------|
| search | string | Query string to be searched on the site | none |
| startUrls | array | List of [Request](https://sdk.apify.com/docs/api/request#docsNav) objects that will be deeply crawled. The URL can be any Zillow.com home list page | none |
| maxItems | number | Maximum number of pages that will be scraped | 200 |
| maxLevel | number | Maximum map splitting level | 20 |
| simple | boolean | Toggle whether simplified results will be returned | true |
| extendOutputFunction | string | Function that takes Zillow home data object ($) as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) | `(data) => { return {}; }` |
| proxyConfiguration | object | Proxy settings of the run. If you have access to Apify proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage | `{ "useApifyProxy": true }`|  

Either the `search` or `startUrls` atrribute has to be set.

### Output

Output is stored in a dataset. Each item is information about a home.
If the `simple` attribute is set, an example result may look like this:
```
{
  "address": {
    "streetAddress": "23840 Hartland St",
    "city": "West Hills",
    "state": "CA",
    "zipcode": "91307",
    "neighborhood": "West Hills",
    "community": null,
    "subdivision": null
  },
  "bedrooms": 3,
  "bathrooms": 2,
  "price": 725000,
  "yearBuilt": 1960,
  "longitude": -118.645963,
  "latitude": 34.194123,
  "description": "Incredible opportunity to transform this wonderful home into your picture of perfection. Situated in a terrific neighborhood, this 3 bedroom, 2 bathroom home is ready for a makeover. Living room, family room with fireplace, dining room, kitchen and master bedroom. It also has a 2 car garage with plenty of room for additional parking. Located close to fantastic restaurants, shopping and transportation make this a must see property. Sold as-is.",
  "livingArea": 1744,
  "currency": "USD",
  "hdpUrl": "/homedetails/23840-Hartland-St-West-Hills-CA-91307/19874958_zpid/",
  "photos": [
    {
      "url": "https://photos.zillowstatic.com/p_f/ISj3uk8gmq0lpl0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/ISn2oqx0ov8rcm0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/ISzbz2uwcvu1xl0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/ISfwlefujn0ucm0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/ISr5xqbq8nm4xl0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/IS7mwhqtpbn83n0000000000.jpg"
    },
    {
      "url": "https://photos.zillowstatic.com/p_f/IS7qj2xnffswcm0000000000.jpg"
    }
  ]
}
```
If the `simple` attribute is not set, the result will contain many more attributes.
You can find example of a full result [here](https://pastebin.com/P016j7ip).

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
