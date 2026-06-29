process.env.GLOBAL_RATE_LIMIT_PAUSES_MS = '50,100,150,200';
process.env.PROXY_SOURCE = 'file';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const catalogCacheTestFile = path.join(__dirname, '.catalog_id_cache_test.json');
try {
  fs.unlinkSync(catalogCacheTestFile);
} catch (err) {
  // ignore missing test cache
}
process.env.CATALOG_CACHE_FILE = catalogCacheTestFile;

const prox = require('./prox.js');
const ax = require('./ax.js');

// Mock Puppeteer
const pupp = require('./pupp.js');
pupp.getCookies = async (proxy, direct, account) => {
    return 'sessionId=mock-session-cookie; guest_city_id=28';
};

const originalProxiesContent = fs.existsSync('proxies.txt') ? fs.readFileSync('proxies.txt', 'utf-8') : '';
const originalSessionsContent = fs.existsSync('proxy_sessions.json') ? fs.readFileSync('proxy_sessions.json', 'utf-8') : '';

function setupTestEnvironment(proxiesList, sessionsData) {
    const proxiesPath = path.join(__dirname, 'proxies.txt');
    const sessionsPath = path.join(__dirname, 'proxy_sessions.json');
    fs.writeFileSync(proxiesPath, proxiesList.map(p => {
        const authPart = p.auth ? `:${p.auth.username}:${p.auth.password}` : '::';
        return `${p.host}:${p.port}${authPart}`;
    }).join('\n'), 'utf-8');
    
    if (sessionsData) {
        fs.writeFileSync(sessionsPath, JSON.stringify(sessionsData, null, 2), { mode: 0o600 });
    } else {
        if (fs.existsSync(sessionsPath)) {
            fs.unlinkSync(sessionsPath);
        }
    }
}

function restoreEnvironment() {
    const proxiesPath = path.join(__dirname, 'proxies.txt');
    const sessionsPath = path.join(__dirname, 'proxy_sessions.json');
    if (originalProxiesContent) {
        fs.writeFileSync(proxiesPath, originalProxiesContent, 'utf-8');
    } else {
        if (fs.existsSync(proxiesPath)) fs.unlinkSync(proxiesPath);
    }
    if (originalSessionsContent) {
        fs.writeFileSync(sessionsPath, originalSessionsContent, 'utf-8');
    } else {
        if (fs.existsSync(sessionsPath)) fs.unlinkSync(sessionsPath);
    }
}

process.on('exit', () => {
  try {
    fs.unlinkSync(catalogCacheTestFile);
  } catch (err) {
    // ignore missing test cache
  }
  restoreEnvironment();
});

function makeProxy(i) {
  return {
    host: `10.0.0.${i}`,
    port: '1080',
    auth: {
      username: 'proxy-user',
      password: 'proxy-pass'
    }
  };
}

function countByAccount(proxies, accountCount) {
  const counts = {};
  for (const proxy of proxies) {
    const accountIndex = prox.getProxyAccountIndex(proxy, accountCount);
    counts[accountIndex] = (counts[accountIndex] || 0) + 1;
  }
  return counts;
}

test('Proxy Pool and Session Management Simulation Suite', async (t) => {

    await t.test('Balanced Logged Pool Selection', () => {
      const proxies = Array.from({ length: 100 }, (_, index) => makeProxy(index + 1));
      const sessions = {};
      for (const proxy of proxies) {
        sessions[proxy.host] = 'sessionId=warm-cache; guest_city_id=28';
      }

      const selection = prox.selectInitialProxyPools(proxies, sessions, 2, 3, 'logged');
      const counts = countByAccount(selection.active, 2);

      assert.strictEqual(selection.active.length, 6, '2 accounts with safe limit 3 must create 6 active proxies');
      assert.ok(Object.values(counts).every(count => count <= 3), `active counts exceed per-account cap: ${JSON.stringify(counts)}`);
      assert.strictEqual(selection.toAuthenticate.length, 0, 'warm cached sessions should not need startup login when active pool is full');
      assert.strictEqual(selection.reserve.length, 94, 'remaining proxies must go to reserve');
    });

    await t.test('Balanced Login Refill Selection', () => {
      const proxies = Array.from({ length: 100 }, (_, index) => makeProxy(index + 1));
      const sessions = {};
      const selection = prox.selectInitialProxyPools(proxies, sessions, 2, 3, 'logged');
      const counts = countByAccount(selection.toAuthenticate, 2);

      assert.strictEqual(selection.active.length, 0, 'empty cache should not mark proxies active before login');
      assert.strictEqual(selection.toAuthenticate.length, 6, 'empty cache should login only the per-account active capacity');
      assert.ok(Object.values(counts).every(count => count <= 3), `login counts exceed per-account cap: ${JSON.stringify(counts)}`);
      assert.strictEqual(selection.reserve.length, 94, 'remaining uncached proxies must stay in reserve');
    });

    await t.test('Guest Pool Does Not Require Cookies', () => {
      const proxies = Array.from({ length: 100 }, (_, index) => makeProxy(index + 1));
      const selection = prox.selectInitialProxyPools(proxies, {}, 2, 3, 'guest');

      assert.strictEqual(selection.toAuthenticate.length, 0, 'guest mode must not schedule Puppeteer logins');
      assert.ok(selection.active.length > 0, 'guest mode should activate proxies without cookies');
      assert.ok(selection.reserve.length > 0, 'guest mode should keep excess proxies in reserve');
    });

    await t.test('Fast Defaults Are Conservative', () => {
      assert.strictEqual(prox.SCRAPE_PROFILE, 'fast', 'default scrape profile should be fast');
      assert.strictEqual(prox.MAX_ACTIVE_PER_ACCOUNT_SAFE, 3, 'fast profile must start with 3 active logged sessions per account');
      assert.strictEqual(prox.MAX_ACTIVE_PER_ACCOUNT_HARD, 5, 'fast profile hard cap should allow auto-growth only up to 5');
      assert.strictEqual(prox.ACCOUNT_REQUEST_CONCURRENCY, 1, 'fast profile should start with 1 in-flight API request per account');
      assert.ok(prox.ACCOUNT_REQUEST_INTERVAL_MIN_MS >= 3000, 'fast profile should throttle logged account request intervals');
      assert.ok(prox.ACCOUNT_REQUEST_INTERVAL_MAX_MS <= 5000, 'fast profile should target sub-3h logged price parsing with two accounts');
      assert.ok(prox.ACCOUNT_REQUEST_INTERVAL_MAX_MS >= prox.ACCOUNT_REQUEST_INTERVAL_MIN_MS, 'account interval max must be >= min');
      
      // Note: Ramping guest concurrency starts at 1, max is 2
      assert.strictEqual(prox.GUEST_REQUEST_CONCURRENCY, 1, 'guest prefetch should start with 1 request lane');
      assert.strictEqual(prox.GUEST_REQUEST_CONCURRENCY_MAX, 2, 'guest prefetch max request lanes should be 2');
      assert.strictEqual(prox.GUEST_INITIAL_ACTIVE_PROXIES, 8, 'guest prefetch should start with 8 active proxies');
      assert.strictEqual(prox.GUEST_MAX_ACTIVE_PROXIES, 16, 'guest prefetch should scale up to 16 active proxies');
      
      assert.ok(prox.GUEST_REQUEST_INTERVAL_MIN_MS >= 600, 'guest prefetch should avoid bursty request pacing');
      assert.ok(prox.GUEST_REQUEST_INTERVAL_MAX_MS <= 1400, 'guest prefetch should keep the total run inside the 3h target');
      assert.strictEqual(prox.canUseDirectFallback(), false, 'direct fallback must stay disabled in proxy mode by default');
    });

    await t.test('Ax Has No Inline Puppeteer Fallback', () => {
      const axPath = path.join(__dirname, 'ax.js');
      const source = fs.readFileSync(axPath, 'utf-8');

      assert.ok(!source.includes("require('./pupp.js')"), 'ax.js must not import Puppeteer');
      assert.ok(!source.includes('fetchViaProxy'), 'ax.js must not call browser fallback during parsing');
      assert.ok(!source.includes('checkLaunchAllowed'), 'ax.js must not launch Puppeteer from request path');
      assert.ok(!source.includes("targetProxy || 'direct'"), 'API helpers must not force direct fallback when proxy mode is active');
    });

    await t.test('Rate Limit Does Not Clear Cookies', () => {
      const axPath = path.join(__dirname, 'ax.js');
      const source = fs.readFileSync(axPath, 'utf-8');
      const rateLimitBlock = source.match(/if \(proxy \&\& \(status === 429 \|\| status === 403\)\) \{[\s\S]*?\n      \}/);
      assert.ok(rateLimitBlock, '429/403 handling block must exist');
      assert.ok(!rateLimitBlock[0].includes('setProxyCookie'), '429/403 must not clear proxy cookies');
      assert.ok(!rateLimitBlock[0].includes('clearAccountSessionByCookie'), '429/403 must not clear account cookies');
      assert.ok(rateLimitBlock[0].includes("markProxyBad(proxy, 'rate_limited')"), '429/403 must quarantine proxy as rate_limited');
    });

    await t.test('Rate Limit Pauses Refill', () => {
      const proxPath = path.join(__dirname, 'prox.js');
      const source = fs.readFileSync(proxPath, 'utf-8');
      assert.ok(source.includes('RATE_LIMIT_REFILL_PAUSE_MS'), 'rate-limit refill pause must be configurable');
      assert.ok(source.includes('refillPausedUntil'), 'rate-limit handling must pause controlled refill');
      assert.ok(source.includes('RATE_LIMIT_PACING_MULTIPLIER'), 'rate-limit handling must slow request pacing');
      assert.ok(source.includes("outcome === 'rate_limited'"), 'rate-limit instability must be explicitly handled');
    });

    await t.test('Catalog Cache Helpers', () => {
      ax.setCachedCatalogId('AAT024', 'ZZVF', 'catalog-1');
      ax.setCachedCatalogId('NO_MATCH', 'ZZVF', null);

      assert.strictEqual(ax.getCachedCatalogId('AAT024', 'ZZVF'), 'catalog-1', 'catalog cache should return stored IDs');
      assert.strictEqual(ax.getCachedCatalogId('NO_MATCH', 'ZZVF'), null, 'catalog cache should preserve negative lookups');
      assert.strictEqual(ax.isCatalogIdCached('NO_MATCH', 'ZZVF'), true, 'negative lookups should count as cached');

      const missing = ax.listMissingCatalogItems([
        { 'Марка': 'ZZVF', 'Номер': 'AAT024' },
        { 'Марка': 'ZZVF', 'Номер': 'NO_MATCH' },
        { 'Марка': 'FEBI', 'Номер': '12345' }
      ]);
      assert.strictEqual(missing.length, 1, 'only uncached catalog lookups should be listed as missing');
      assert.strictEqual(missing[0].Номер, '12345');

      const stats = ax.getCatalogCacheStats(missing);
      assert.strictEqual(stats.missingRequestedItems, 1, 'cache stats should report missing requested items');
      ax.flushCatalogCache();
      assert.ok(fs.existsSync(catalogCacheTestFile), 'catalog cache should flush to disk');
    });

    await t.test('Production Run Safeguards', () => {
      const indexPath = path.join(__dirname, 'index.js');
      const source = fs.readFileSync(indexPath, 'utf-8');

      assert.ok(source.includes('parser_checkpoint.jsonl'), 'parser must persist item-level checkpoints');
      assert.ok(source.includes('appendCheckpoint'), 'parser must append checkpoint records during main and retry flows');
      assert.ok(source.includes('RESUME_CHECKPOINT'), 'parser checkpoint resume must be configurable');
      assert.ok(source.includes('ALLOW_GUEST_PRICE_MODE'), 'main price parsing must not silently switch to guest mode');
      assert.ok(source.includes("setRuntimeAuthMode('logged')"), 'main price parsing should force logged mode unless explicitly overridden');
      assert.ok(source.includes('buildProductionDiagnostics'), 'parser must expose production run diagnostics');
      assert.ok(source.includes("app.get('/diagnostics'"), 'server should expose a diagnostics endpoint');
      assert.ok(source.includes('--diagnostics'), 'CLI diagnostics mode must run without scraping');
      assert.ok(source.includes('requiredAccountsForTarget'), 'diagnostics must estimate account capacity for the target runtime');
      assert.ok(source.includes('catalogPrefetchPhase'), 'diagnostics must include catalog prefetch ETA');
      assert.ok(source.includes('totalRuntime'), 'diagnostics must include total runtime ETA');
      assert.ok(source.includes('Estimated total runtime'), 'diagnostics output must show total runtime');
      assert.ok(source.includes('GUEST_REQUEST_CONCURRENCY * 4'), 'guest prefetch workers should follow the bounded guest scheduler');
    });

    await t.test('Double Leasing Prevention', async () => {
        setupTestEnvironment(
            [{ host: '10.0.0.1', port: '1080' }],
            {
                version: 2,
                proxySessions: {
                    "10.0.0.1:1080": "sessionId=test-session-cookie; guest_city_id=28"
                },
                proxySessionMeta: {}
            }
        );
        
        process.env.AUTH_MODE = 'logged';
        prox.setRuntimeAuthMode('logged');
        await prox.initprox();
        
        assert.strictEqual(prox.getWorkingProxiesCount(), 1);
        
        const lease1 = await prox.acquireProxyLease({ timeoutMs: 1000 });
        assert.ok(lease1);
        assert.strictEqual(lease1.proxy.host, '10.0.0.1');
        
        await assert.rejects(
            prox.acquireProxyLease({ timeoutMs: 250 }),
            { code: 'PROXY_LEASE_TIMEOUT' }
        );
        
        lease1.release('test_ready');
        
        const lease2 = await prox.acquireProxyLease({ timeoutMs: 1000 });
        assert.ok(lease2);
        lease2.release('test_ready');
        
        restoreEnvironment();
    });

    await t.test('Session V1->V2 Migration', () => {
        const v1Sessions = {
            "10.0.0.1:1080": "sessionId=migrated-session-1",
            "10.0.0.2:1080": "sessionId=migrated-session-2"
        };
        
        setupTestEnvironment([], v1Sessions);
        
        prox.initprox();
        
        const content = JSON.parse(fs.readFileSync('proxy_sessions.json', 'utf-8'));
        assert.strictEqual(content.version, 2);
        assert.ok(content.proxySessions);
        assert.strictEqual(content.proxySessions["10.0.0.1:1080"], "sessionId=migrated-session-1");
        assert.strictEqual(content.proxySessions["10.0.0.2:1080"], "sessionId=migrated-session-2");
        assert.ok(content.proxySessionMeta);
        assert.ok(content.proxySessionMeta["10.0.0.1:1080"]);
        
        const stats = fs.statSync('proxy_sessions.json');
        const mode = stats.mode & 0o777;
        if (process.platform !== 'win32') {
            assert.strictEqual(mode, 0o600, 'File permissions must be 0o600');
        }
        
        restoreEnvironment();
    });

    await t.test('Guest Cookie Continuity', async () => {
        setupTestEnvironment(
            [{ host: '10.0.0.1', port: '1080' }],
            null
        );
        
        process.env.AUTH_MODE = 'guest';
        prox.setRuntimeAuthMode('guest');
        
        await prox.initprox();
        
        const p = { host: '10.0.0.1', port: '1080' };
        prox.setProxyGuestCookie(p, 'guest_city_id=28; guest_session=bootstrap');
        
        const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
        assert.ok(lease);
        assert.strictEqual(lease.ua.Cookie, 'guest_city_id=28; guest_session=bootstrap');
        lease.release();
        
        restoreEnvironment();
    });

    await t.test('Persistent Quarantine on Startup', async () => {
        const futureTime = Date.now() + 600000; // 10 minutes in future
        setupTestEnvironment(
            [{ host: '10.0.0.1', port: '1080' }],
            {
                version: 2,
                proxySessions: {
                    "10.0.0.1:1080": "sessionId=test-session-cookie"
                },
                proxySessionMeta: {
                    "10.0.0.1:1080": {
                        proxyKey: "10.0.0.1:1080",
                        quarantineUntil: new Date(futureTime).toISOString()
                    }
                }
            }
        );
        
        process.env.AUTH_MODE = 'logged';
        prox.setRuntimeAuthMode('logged');
        
        await prox.initprox();
        
        const workingCount = prox.getWorkingProxiesCount();
        assert.strictEqual(workingCount, 0, 'Quarantined proxy must not be active');
        
        restoreEnvironment();
    });

    await t.test('Global Circuit Breaker Probe Success and Failure', async () => {
        setupTestEnvironment(
            [
                { host: '10.0.0.1', port: '1080' },
                { host: '10.0.0.2', port: '1080' },
                { host: '10.0.0.3', port: '1080' }
            ],
            {
                version: 2,
                proxySessions: {
                    "10.0.0.1:1080": "sessionId=cookie-1",
                    "10.0.0.2:1080": "sessionId=cookie-2",
                    "10.0.0.3:1080": "sessionId=cookie-3"
                },
                proxySessionMeta: {}
            }
        );
        
        process.env.AUTH_MODE = 'logged';
        prox.setRuntimeAuthMode('logged');
        
        await prox.initprox();
        
        const p1 = { host: '10.0.0.1', port: '1080' };
        const p2 = { host: '10.0.0.2', port: '1080' };
        const p3 = { host: '10.0.0.3', port: '1080' };
        
        // 1. Trigger circuit breaker
        prox.recordProxyResult(p1, 'rate_limited');
        prox.recordProxyResult(p2, 'rate_limited');
        prox.recordProxyResult(p3, 'rate_limited');
        
        let snapshot = prox.getProxyPoolSnapshot();
        assert.strictEqual(snapshot.globalRateLimit.stage, 1);
        assert.ok(snapshot.globalRateLimit.openRemainingMs > 0);
        
        // 2. Wait for it to become half-open (pause is 50ms)
        await new Promise(resolve => setTimeout(resolve, 60));
        
        // 3. Acquire slot (should be half-open probe)
        const releaseSlot = await prox.acquireRequestSlot(p1);
        snapshot = prox.getProxyPoolSnapshot();
        assert.ok(snapshot.globalRateLimit.halfOpenProbeInFlight);
        
        // 4. Release with success
        releaseSlot('success');
        
        snapshot = prox.getProxyPoolSnapshot();
        assert.strictEqual(snapshot.globalRateLimit.stage, 0);
        assert.strictEqual(snapshot.globalRateLimit.halfOpenProbeInFlight, false);
        
        // 5. Trigger again
        prox.recordProxyResult(p1, 'rate_limited');
        prox.recordProxyResult(p2, 'rate_limited');
        prox.recordProxyResult(p3, 'rate_limited');
        
        snapshot = prox.getProxyPoolSnapshot();
        assert.strictEqual(snapshot.globalRateLimit.stage, 1);
        
        // 6. Wait for half-open again
        await new Promise(resolve => setTimeout(resolve, 60));
        
        // 7. Acquire slot
        const releaseSlot2 = await prox.acquireRequestSlot(p1);
        
        // 8. Release with failure
        releaseSlot2('rate_limited');
        
        // 9. Verify it escalated to stage 2
        snapshot = prox.getProxyPoolSnapshot();
        assert.strictEqual(snapshot.globalRateLimit.stage, 2);
        assert.strictEqual(snapshot.globalRateLimit.halfOpenProbeInFlight, false);
        
        restoreEnvironment();
    });

    await t.test('Fixture schemas parsing', () => {
        // 1. Searchdetails schema
        const mockSearchDetailsAmbiguous = {
            success: true,
            data: {
                catalogs: [
                    { id: 12345, catalogName: "ZZVF", number: "AAT024" },
                    { id: 67890, catalogName: "ZZVF", number: "AAT024" }
                ]
            }
        };
        
        const mockSearchDetailsSingle = {
            success: true,
            data: {
                catalogs: [
                    { id: 12345, catalogName: "ZZVF", number: "AAT024" }
                ]
            }
        };
        
        const mockSearchDetailsEmpty = {
            success: true,
            data: {
                catalogs: []
            }
        };
        
        // Test selectCatalog with ambiguous brands
        const selectAmbiguous = ax.selectCatalog(mockSearchDetailsAmbiguous.data.catalogs, 'ZZVF', 'AAT024');
        assert.strictEqual(selectAmbiguous.status, 'ambiguous');
        assert.strictEqual(selectAmbiguous.catalog, null);
        assert.strictEqual(selectAmbiguous.candidates.length, 2);
        
        // Test selectCatalog with single valid catalog
        const selectSingle = ax.selectCatalog(mockSearchDetailsSingle.data.catalogs, 'ZZVF', 'AAT024');
        assert.strictEqual(selectSingle.status, 'resolved');
        assert.strictEqual(selectSingle.catalog.id, 12345);
        
        // Test selectCatalog with empty catalogs
        const selectEmpty = ax.selectCatalog(mockSearchDetailsEmpty.data.catalogs, 'ZZVF', 'AAT024');
        assert.strictEqual(selectEmpty.status, 'not_found');
        assert.strictEqual(selectEmpty.catalog, null);
        
        // 2. Appraise schema
        const mockAppraiseSuccess = {
            success: true,
            data: {
                appriseInfo: [
                    { priceId: 501, price: 450.00, quantity: 10, deliveryDays: 1, catalogName: "ZZVF", shortName: "AAT024", articleId: 12345 },
                    { priceId: 502, price: 320.00, quantity: 5, deliveryDays: 2, catalogName: "ZZVF", shortName: "AAT024", articleId: 12345 },
                    { priceId: 503, price: 600.00, quantity: 1, deliveryDays: 9, catalogName: "ZZVF", shortName: "AAT024", articleId: 12345 }
                ]
            }
        };
        
        const mockAppraiseEmpty = {
            success: true,
            data: {
                appriseInfo: []
            }
        };
        
        // Test processAppraiseOffers
        const offers = ax.processAppraiseOffers(
            { Номер: 'AAT024', Марка: 'ZZVF', цена: '1000' },
            mockAppraiseSuccess.data.appriseInfo.filter(o => o.deliveryDays <= 7)
        );
        
        assert.strictEqual(offers.length, 2);
        assert.strictEqual(offers[0].Мин_Цена, '320');
        assert.strictEqual(offers[1].Мин_Цена, '320');
        assert.strictEqual(offers[0].Цена, 450);
        assert.strictEqual(offers[1].Цена, 320);
        
        const emptyOffers = ax.processAppraiseOffers(
            { Номер: 'AAT024', Марка: 'ZZVF', цена: '1000' },
            mockAppraiseEmpty.data.appriseInfo
        );
        assert.strictEqual(emptyOffers, null);
        
        // 3. Speculative getcosts schema verification
        const mockGetCosts = {
            success: true,
            data: {
                costs: [
                    { routeId: "APPRAISE_PRODUCT", deliveryCost: 150.00, deliveryDays: 2, officeId: 28 }
                ]
            }
        };
        
        assert.strictEqual(mockGetCosts.success, true);
        assert.strictEqual(mockGetCosts.data.costs[0].routeId, "APPRAISE_PRODUCT");
        assert.strictEqual(mockGetCosts.data.costs[0].deliveryCost, 150.00);
        assert.strictEqual(mockGetCosts.data.costs[0].deliveryDays, 2);
        assert.strictEqual(mockGetCosts.data.costs[0].officeId, 28);
    });
});
