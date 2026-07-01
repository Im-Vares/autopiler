# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Node.js scraper for autopiter.ru auto-parts pricing. No framework beyond Express (used only as a control-plane HTTP server). Input is a tab-separated price file read from the SMB network share (`/mnt/smb-share/выгрузки ежедневные клиентам/Выгрузка цен Инфопартс прайс1.txt`); outputs are XLSX workbooks plus a streaming JSONL checkpoint and a per-run manifest.

The full requirements specification lives in `ORIGINAL_REQUEST.md`. Treat it as the contract: proxy-pool invariants, HTTP-client rules, data-quality rules, and acceptance criteria are written there. When in doubt about intended behavior, read it before changing code.

Russian sources, file names, and identifiers (Марка, Номер, etc.) are part of the schema — preserve them exactly.

## Common commands

```bash
npm test                            # node:test runner against tests/e2e.test.js
node -c prox.js && node -c ax.js && node -c index.js && node -c pupp.js && node -c files.js  # syntax check
node index.js                       # start Express control plane on :18081 by default
node index.js --direct              # one-shot scrape, no HTTP server
node index.js --diagnostics         # production-readiness check, exits 0/1 without scraping
node --test tests/e2e.test.js --test-name-pattern="Feature 1"   # run a single suite
```

Control-plane endpoints (when running without `--direct`): `/start`, `/stop`, `/get`, `/proxies/status`, `/proxies/reload`, `/diagnostics`, `/metrics`.

The scheduler runs `start()` daily at 20:20 local time via `node-cron`.

## Architecture

Five top-level modules, layered strictly:

- **`files.js`** — pure I/O. Reads `proxies.txt` and the input TXT/XLSX, writes the three output workbooks (`final`, `positions`, `horizontal`). Auto-detects UTF-8 vs Windows-1251.
- **`prox.js`** (~2000 lines, the core of the system) — proxy pool, session cache, request scheduler, global circuit breaker. Exports the async lease API (`acquireProxyLease`, `acquireRequestSlot`, `releaseProxyLease`), session persistence (`flushProxySessions`), and mode controls. `getUa()` is legacy and must not be used as the primary acquisition path.
- **`pupp.js`** — the **only** module allowed to launch Puppeteer. Global concurrency = 1, per-account mutex, SOCKS tunnel torn down immediately after cookies are captured. Callers pass an explicit `accountIndex`; `pupp.js` does not re-derive it.
- **`ax.js`** — axios HTTP client + Autopiter API calls (`getId` → `searchdetails`, `getInfo` → `appraise`). Owns the catalog cache, brand matching (`selectCatalog`), and offer filtering. **Must not** require `pupp.js` and **must not** send `Origin` or `X-Requested-With` on GET requests. Every request includes a unique `x-ap-request-id`.
- **`index.js`** — orchestration: Express routes, `start()` pipeline, checkpoint/manifest, catalog prefetch, guest↔logged comparison, scheduler, signal handling.

### Critical invariants (enforced by tests; do not regress)

- A leased proxy is never returned to another caller. All proxy acquisition flows through `acquireProxyLease()`; `release(outcome)` updates cooldown, health, stats.
- Proxy states: `reserve` → `auth_pending` → `ready` → `leased` → (`cooldown` | `invalid` | `quarantined`). `quarantineUntil` persists across restarts — recently-429/403 IPs must not rejoin the active pool on boot.
- Guest mode defaults: 8 active proxies, 1 request lane. Ramp to 16/2 only after 50 consecutive block-free successes.
- Logged mode defaults: ≤3 sessions per account, 1 concurrent request per account lane, 8–12s per-proxy cooldown. Sessions are balanced strictly across accounts.
- Global circuit breaker: 3 distinct-IP blocks within 30s → pause 2 min → 5 → 15 → max 30 min. Recovery uses a single probe before resuming.
- `Retry-After` is honored; network errors back off without destroying cookies. Direct fallback and cookie-sharing between proxies are disabled.
- `selectCatalog()` returns `ambiguous` for multiple distinct matches and `not_found` (never the first entry) when no exact brand match exists.
- Offer filter: `price > 0`, `quantity > 0`, `0 ≤ deliveryDays ≤ 7`; dedupe by `detailUid` or composite `priceId|id|price`.
- Per-item retry is capped at 3 (`MAX_REQUEST_RETRIES`); one part cannot burn through 8 proxies.
- Catalog cache TTLs: 14 days for resolved, 24 h for negative.
- Production prices use logged mode (`appraise`). Guest `searchdetails` is for prefetch only. `runGuestComparison` is diagnostic on ≤20 items and must not switch production to guest pricing — gate that on `ALLOW_GUEST_PRICE_MODE=1`.
- Checkpoint terminal statuses: `success`, `no_offers`, `not_found`, `ambiguous`, plus retryable `retryable_error`. A run is "successful" only with zero unresolved/error positions.

### State files (atomic writes, 0600 perms where sensitive)

- `proxy_sessions.json` — format v2 with v1→v2 migration in `migrateV1ToV2`. Atomic write via temp + rename.
- `catalog_id_cache.json` — debounced async writes, sync flush on shutdown.
- `runtime/parser_checkpoint.jsonl` — append-only JSONL; resume reads keyed by `getItemKey`.
- `runtime/run_manifest.json` — full input-position manifest produced per run.

### Signal handling

`SIGINT`/`SIGTERM` trigger `handleExit()`, which calls `pupp.closeAllSessions()` then `flushProxySessions()` synchronously before `process.exit(0)`. Don't bypass.

## Key environment variables

`MAX_REQUEST_RETRIES` (≤3), `SCRAPE_LIMIT`, `CHECKPOINT_ENABLED`, `CHECKPOINT_FILE`, `RUN_MANIFEST_FILE`, `CATALOG_CACHE_FILE`, `CATALOG_CACHE_TTL_DAYS`, `CATALOG_CACHE_NEGATIVE_TTL_HOURS`, `CATALOG_PREFETCH_ONLY`, `ALLOW_GUEST_PRICE_MODE`, `PARSER_CONCURRENCY`, `VALIDATE_CACHED_SESSIONS`, `DIAGNOSTICS_ONLY`.

## Working with this codebase

- `.agents/AGENTS.md` lists scraping/proxy operational rules learned from past incidents — read it before changing rotation, session-cache, or Puppeteer flows.
- All existing module exports must stay backward-compatible (acceptance criterion).
- Prefer editing `prox.js` / `ax.js` / `index.js` in-place over creating new helper modules.
- Do not reintroduce Puppeteer launches outside `pupp.js`, inline delays inside `getId`/`getInfo`, or first-entry fallbacks in catalog selection — each has been explicitly removed.
