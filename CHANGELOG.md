## 2021-01-30

Features:
- Completely refactored code
- Support for external urls for start urls
- Can accept search urls containing searchQueryState with specific filters
- Added improved `extendOutputFunction` and `extendScraperFunction`
- Additional parameters that can be provided
- Improved initial search
- Added ability for `sold` listings
- More consistent output for number of items
- Hint for residentials, works much better than datacenter proxies
- Filter for data not containing zipd (non-listing)

Fixes:
- Fixed infinite loop while scanning for houses
- Lint and code reorganization
- Retries failing detail urls
- Require the use of proxies
- Better headers to match the website requests through `fetch`
