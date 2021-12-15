## 2021-12-03


## 2021-08-03

Feature:
- Update SDK to latest
- Translation of searchQueryState to search query
- Use header generator for user-agent

Bug fixes:
- Workaround too many captchas

## 2021-07-21

Feature:
- Updated SDK
- Min / max dates for listings
- Debug log

Changes:
- Strictly filter everything if `Type` isn't "All"
- Better management of max items
- Handle interstitial

Bug fixes:
- FSBO listings
- Getting query id
- Properly retiring browser instance
- "All" setting with search term

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
