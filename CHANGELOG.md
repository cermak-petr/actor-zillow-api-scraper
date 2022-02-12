## 2022-02-11

Features:
- Better splitting of big areas
- Better filtering of results
- Better logging

Fix:
- Map zoom on splits
- Handle page timeout in 120s instead of 1h
- Retrying of empty results
- Paginating of results
- Retrying of pages without zpid
- Unecessarily retrying on invalid listings

## 2022-02-06

Fix:
- Photos

## 2022-01-07

Features:
- Add pagination search inspecting listing results (more items scraped while testing)
- Use pagination search for all pages (with properties <= 500, > 500 ) for more results

Bug fixes:
- Fix query states fetch request (map results weren't loaded properly)
- Remove residential proxies recommendation
- Use map splitting only for results > 500

Dev:
- Refactor code (split `main` function, `handlePageFuntion`)
- Update to SDK v2.2
- Replace header generator for user-agent with SDK built-in fingerprints support
- Handle most of the tslint warnings

## 2021-12-01

Bug fixes:
- Handle request blocking by retrying requests with 0 results found
- Increase number of dataset results by forcing map splitting for results < 500

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
