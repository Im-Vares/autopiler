# Original User Request

## Initial Request — 2026-06-28T15:00:06Z

Stabilize the Autopiter web scraper's proxy pool, HTTP client, data quality pipeline, and test suite. The project is an existing Node.js codebase (no framework) that scrapes autopiter.ru for auto parts pricing. The goal is production reliability — zero lost or incorrect positions — not maximum throughput.

Working directory: /Users/OlgaVerbickaa1/Desktop/Архивы/Проекты/Проекты/avtopit
Integrity mode: development

## Requirements

### R1. Proxy Pool — Exclusive Async Lease

All proxy acquisition must go through `acquireProxyLease()` in `prox.js`. The legacy `getUa()` function must no longer be the primary acquisition path used by `ax.js` or `index.js` for API requests. Each proxy tracks formal states (`reserve`, `auth_pending`, `ready`, `leased`, `cooldown`, `invalid`, `quarantined`). `release(outcome)` updates cooldown, health, and statistics. A proxy that is currently leased must never be returned to another caller.

**Guest-mode defaults:** 8 initial active proxies, 1 global request lane. After 50 consecutive successes without blocks, ramp to 2 lanes and up to 16 active proxies.

**Logged-mode defaults:** max 3 sessions per account (safe), strictly balanced across accounts; 1 concurrent API request per account lane; proxy cooldown 8–12 seconds between uses.

Remaining proxies stay in reserve, selected by lowest `lastUsedAt`. Logged-cookie and guest-cookie are stored separately per proxy. Each proxy preserves its own `guestId`, fingerprint profile, and account assignment.

`proxy_sessions.json` uses format version 2 with migration from v1, atomic write via temp file + rename, and file permissions `0o600`. `quarantineUntil` is persisted; on restart, recently-429/403'd IPs must NOT become active.

**Global circuit breaker:** 3 blocks on distinct IPs within 30 seconds pauses all requests for 2 min, then 5, 15, max 30 min on repeated triggers. Recovery starts with a single probe request.

`Retry-After` header is honored. Network errors use short exponential backoff and do NOT destroy cookies. Direct fallback and cookie-sharing between proxies remain disabled.

### R2. HTTP Client & Auth — Puppeteer Isolation

Puppeteer is allowed ONLY in the dedicated auth worker (`pupp.js`) with global concurrency 1 and per-account mutex. The caller passes an explicit `accountIndex`; `pupp.js` does not re-derive it. After cookies are obtained, the browser and SOCKS tunnel are closed immediately. No background Chrome sessions persist during parsing.

Challenge pages ("Я не робот") put the proxy and account into cooldown — no bypass attempts. `ax.js` must NOT import or invoke Puppeteer anywhere. Retry/error handlers for guest/401/429 must NOT launch Puppeteer.

API request headers use a stable per-session fingerprint (consistent User-Agent, `sec-ch-ua*` client hints) and a unique `x-ap-request-id` per request. Remove `Origin` and `X-Requested-With` headers that real browser GET requests to the API do not send.

All request pacing is centralized in the proxy scheduler (`acquireRequestSlot`); remove any additional inline delays from `getId()` and `getInfo()` in `ax.js`. Retry is limited to a maximum of 3 classified attempts per item so a single part cannot burn through 8 proxies.

### R3. Data Quality — Brand Matching, Offers, Manifest

Catalog prefetch uses guest-mode `searchdetails`; production prices default to logged-mode via `appraise`.

Brand matching: select only an exact normalized match or an unambiguous alias. No fallback to the first catalog entry. Ambiguous results are recorded as `ambiguous` in the catalog cache.

Catalog cache stores `id`, `catalogName`, match status, and timestamp. Negative results use a 24-hour TTL; successful lookups use a 14-day TTL.

Offer filtering: select by the chosen `articleId`, canonical brand, and article number; require positive price and quantity; delivery 0–7 days. Deduplicate by `detailUid`/`priceId`. Distinguish `no_offers`, `not_found`, `ambiguous`, `retryable_error` in checkpoint status.

Checkpoint expands to a full run manifest covering all input positions. A run is considered successful only when there are zero unresolved/error positions.

Guest/logged comparison remains a separate diagnostic mode on ≤20 items; it must NOT automatically switch production to guest-price mode.

### R4. Test Suite — `node:test` Migration & Fixtures

Migrate all tests to the built-in `node:test` module (available in Node 18+). Test cases must cover:
- Account balance across proxies
- Prevention of double-leasing a busy proxy
- Session state v1→v2 migration
- Guest-cookie (`guestId`) continuity across requests per proxy
- Persistent quarantine surviving restarts
- Global circuit breaker escalation stages
- Absence of inline Puppeteer in `ax.js`

Add fixture tests with realistic JSON response schemas for `searchdetails`, `appraise`, and `getcosts`, including ambiguous brands and empty offers.

Update `package.json` `"test"` script to run the new `node:test`-based test file.

## Acceptance Criteria

### Syntax & Static Checks
- [ ] `node -c prox.js && node -c ax.js && node -c index.js && node -c pupp.js && node -c files.js` exits 0
- [ ] `npm test` runs all `node:test` tests and exits 0

### Proxy Pool Invariants
- [ ] `acquireProxyLease()` never returns a proxy whose key is in the `busyProxies` set
- [ ] Guest-mode starts with exactly 1 request lane and 8 active proxies (configurable via env)
- [ ] Logged-mode enforces ≤3 active sessions per account at startup
- [ ] Proxies with `quarantineUntil` in the future are NOT placed in the active pool on startup
- [ ] Circuit breaker opens after 3 rate-limit events on distinct IPs within 30s, pauses for 2 min initially

### HTTP Client Invariants
- [ ] `ax.js` source does NOT contain `require('./pupp.js')` or `require("./pupp.js")`
- [ ] `ax.js` GET request headers do NOT include `Origin` or `X-Requested-With`
- [ ] Every API request includes a unique `x-ap-request-id` header
- [ ] Maximum retry count per `get()` call is 3 (configurable via `MAX_REQUEST_RETRIES` env var)
- [ ] `set-cookie` response headers in guest-mode are merged into the proxy's guest cookie (preserving `guestId`)

### Data Quality Invariants
- [ ] `selectCatalog()` returns `{ status: 'ambiguous' }` when multiple distinct catalog IDs match the same brand+number
- [ ] `selectCatalog()` returns `{ status: 'not_found' }` — never falls back to the first entry — when no exact brand match exists
- [ ] Offer filtering requires `price > 0`, `quantity > 0`, `deliveryDays >= 0 && <= 7`
- [ ] Offers are deduplicated by `detailUid` or composite `priceId|id|price` key
- [ ] Checkpoint distinguishes all 4 terminal statuses: `success`, `no_offers`, `not_found`, `ambiguous` and the retryable status `retryable_error`

### Diagnostics
- [ ] `node index.js --diagnostics` runs without starting the scraper and exits 0 (requires input file to exist)

### No Regressions  
- [ ] All existing exports from `prox.js`, `ax.js`, `index.js`, `pupp.js`, `files.js` remain available (backward-compatible)
- [ ] `proxy_sessions.json` v1 data is correctly migrated to v2 on load
