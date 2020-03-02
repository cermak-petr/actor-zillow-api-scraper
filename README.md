### Zillow.com Scraper

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
| startUrls | array | List of [Request](https://sdk.apify.com/docs/api/request#docsNav) objects that will be deeply crawled. The URL can be top level like `https://www.firmy.cz`, any category URL or company detail URL | none |
| maxItems | number | Maximum number of pages that will be scraped | 200 |
| maxLevel | number | Maximum map splitting level | 20 |
| extendOutputFunction | string | Function that takes Zillow home data object ($) as argument and returns data that will be merged with the default output. More information in [Extend output function](#extend-output-function) | (data) => {return {};} |
| proxyConfiguration | object | Proxy settings of the run. If you have access to Apify proxy, leave the default settings. If not, you can set `{ "useApifyProxy": false" }` to disable proxy usage | `{ "useApifyProxy": true }`|  

Either the `search` or `startUrls` atrribute has to be set.

### Output

Output is stored in a dataset. Each item is information about a home.
You can find example of an output [here](https://pastebin.com/P016j7ip).

### Compute units consumption
Keep in mind that it is much more efficient to run one longer scrape (at least one minute) than more shorter ones because of the startup time.

The average consumption is about **0.6 Compute units per 2000 results** scraped.

### Extend output function

You can use this function to update the default output of this actor. This function gets Zillow internal home data object as an argument, so you can choose which other attributes you would like to add. The output from this will function will get merged with the default output.
  
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
Thank you for trying my actor. You can send any feedback you have to my email `petr.cermak@apify.com`.  
If you find any bug, please create an issue on the [Github page](https://github.com/cermak-petr/actor-zillow-api-scraper).
