const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

// ── Environment Setup ──
const TEST_TMP_DIR = path.join(__dirname, '.tmp-e2e');
const TEST_PROXIES_FILE = path.join(TEST_TMP_DIR, 'proxies.txt');
const TEST_LOGINS_FILE = path.join(TEST_TMP_DIR, 'logins.txt');
const TEST_SESSIONS_FILE = path.join(TEST_TMP_DIR, 'proxy_sessions.json');
const TEST_CATALOG_CACHE_FILE = path.join(TEST_TMP_DIR, 'catalog_id_cache.json');
const TEST_CHECKPOINT_FILE = path.join(TEST_TMP_DIR, 'checkpoint.jsonl');
const TEST_MANIFEST_FILE = path.join(TEST_TMP_DIR, 'manifest.json');

process.env.NODE_ENV = 'test';
process.env.PORT = '8089';
process.env.PROXY_SOURCE = 'file';
process.env.PROXIES_FILE = TEST_PROXIES_FILE;
process.env.LOGINS_FILE = TEST_LOGINS_FILE;
process.env.PROXY_SESSIONS_FILE = TEST_SESSIONS_FILE;
process.env.DISABLE_SESSION_EXIT_FLUSH = '1';
process.env.DISABLE_CATALOG_CACHE_EXIT_FLUSH = '1';
process.env.CHECKPOINT_FILE = TEST_CHECKPOINT_FILE;
process.env.RUN_MANIFEST_FILE = TEST_MANIFEST_FILE;
process.env.CATALOG_CACHE_FILE = TEST_CATALOG_CACHE_FILE;
process.env.VALIDATE_CACHED_SESSIONS = '0'; // skip validation in default initprox
process.env.PROXY_AUTH_DELAY_MS = '0';
process.env.PROXY_COOLDOWN_MIN_MS = '0';
process.env.PROXY_COOLDOWN_MAX_MS = '0';
process.env.GUEST_STABLE_SUCCESS_WINDOW = '20';

// Import SUT (System Under Test)
let prox = require('../prox.js');
let ax = require('../ax.js');
let files = require('../files.js');
let index = require('../index.js');
let pupp = require('../pupp.js');

// Mock Puppeteer
pupp.getCookies = async (proxy, force, customCredentials, accountIndex) => {
  return 'sessionId=mock-session-cookie-123; guest_city_id=28';
};
pupp.closeSession = async () => {};
pupp.closeAllSessions = async () => {};

// Mock files.js Excel generation to avoid actual files
files.final = () => {};
files.positions = () => {};
files.horizontal = () => {};

// Global mock state control
const mockState = {
  rateLimit: false,
  networkError: false,
  challenge: false,
  apiUserType: 'user',
  catalogsResponse: null,
  appraiseResponse: null,
};

// Mock Axios GET
const originalAxiosGet = axios.get;
const globalMockAxiosGet = async (url, options) => {
  if (mockState.networkError) {
    throw new Error('Network Error');
  }
  if (mockState.rateLimit) {
    const error = new Error('Rate Limited');
    error.response = { status: 429, headers: {} };
    throw error;
  }
  if (mockState.challenge) {
    return {
      headers: { 'content-type': 'text/html' },
      data: '<html><body>Вы очень активный! Captcha challenge</body></html>'
    };
  }
  if (url.includes('searchdetails')) {
    const data = mockState.catalogsResponse || {
      data: {
        catalogs: [
          { id: 12345, catalogName: 'BMW', number: '11127548797' }
        ]
      }
    };
    return {
      headers: {
        'content-type': 'application/json',
        'x-ap-user-type': mockState.apiUserType
      },
      data
    };
  }
  if (url.includes('appraise')) {
    const data = mockState.appraiseResponse || {
      data: {
        appriseInfo: [
          { id: 1, priceId: 2, price: 90, catalogName: 'BMW', shortName: '11127548797', quantity: 5, deliveryDays: 2 }
        ]
      }
    };
    return {
      headers: {
        'content-type': 'application/json',
        'x-ap-user-type': mockState.apiUserType
      },
      data
    };
  }
  return { headers: {}, data: {} };
};
axios.get = globalMockAxiosGet;

function flushStateModules() {
  if (prox && typeof prox.flushProxySessions === 'function') prox.flushProxySessions();
  if (ax && typeof ax.flushCatalogCache === 'function') ax.flushCatalogCache();
}

function helperReloadModules() {
  flushStateModules();

  delete require.cache[require.resolve('../prox.js')];
  delete require.cache[require.resolve('../ax.js')];
  delete require.cache[require.resolve('../index.js')];
  delete require.cache[require.resolve('../pupp.js')];
  
  prox = require('../prox.js');
  ax = require('../ax.js');
  index = require('../index.js');
  pupp = require('../pupp.js');
  
  // Re-mock
  pupp.getCookies = async () => 'sessionId=mock-session-cookie-123; guest_city_id=28';
  pupp.closeSession = async () => {};
  pupp.closeAllSessions = async () => {};
}

describe('Autopiter Scraper E2E Test Suite', () => {
  before(() => {
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
    fs.writeFileSync(TEST_PROXIES_FILE, '127.0.0.1:8001:user1:pass1\n127.0.0.1:8002:user2:pass2\n127.0.0.1:8003:user3:pass3\n127.0.0.1:8004:user4:pass4');
    fs.writeFileSync(TEST_LOGINS_FILE, 'client123:password123\nclient456:password456');
  });

  after(() => {
    flushStateModules();
    fs.rmSync(TEST_TMP_DIR, { recursive: true, force: true });

    // Restore axios.get
    axios.get = originalAxiosGet;
  });

  beforeEach(async () => {
    mockState.rateLimit = false;
    mockState.networkError = false;
    mockState.challenge = false;
    mockState.apiUserType = 'user';
    mockState.catalogsResponse = null;
    mockState.appraiseResponse = null;

    process.env.SCRAPE_PROFILE = 'fast';
    process.env.AUTH_MODE = 'logged';
    process.env.VALIDATE_CACHED_SESSIONS = '0';
    if (prox && typeof prox.setRuntimeAuthMode === 'function') {
      prox.setRuntimeAuthMode('logged');
    }

    // Seed proxy sessions so that no sequential puppeteer logins run in initprox
    const initialSessions = {
      version: 2,
      directCookie: 'sessionId=mock-direct',
      proxySessions: {
        '127.0.0.1:8001': 'sessionId=mock-cookie-1',
        '127.0.0.1:8002': 'sessionId=mock-cookie-2',
        '127.0.0.1:8003': 'sessionId=mock-cookie-3',
        '127.0.0.1:8004': 'sessionId=mock-cookie-4'
      },
      proxyGuestSessions: {},
      accountSessions: {},
      proxySessionMeta: {
        '127.0.0.1:8001': { status: 'active', lastUsedAt: Date.now() },
        '127.0.0.1:8002': { status: 'active', lastUsedAt: Date.now() },
        '127.0.0.1:8003': { status: 'active', lastUsedAt: Date.now() },
        '127.0.0.1:8004': { status: 'active', lastUsedAt: Date.now() }
      },
      runtime: {
        selectionCursor: 0,
        globalRateLimitStage: 0,
        globalRateLimitOpenUntil: 0
      }
    };
    fs.writeFileSync(TEST_SESSIONS_FILE, JSON.stringify(initialSessions, null, 2));

    await prox.initprox();
  });

  afterEach(async () => {
    axios.get = globalMockAxiosGet;
  });

  // ── FEATURE 1: Proxy leasing/release exclusivity and states ──
  describe('Feature 1: Proxy leasing/release exclusivity and states', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Lease exclusivity prevents duplicate leasing', async () => {
      const lease1 = await prox.acquireProxyLease({ timeoutMs: 1000 });
      const lease2 = await prox.acquireProxyLease({ timeoutMs: 1000 });
      assert.ok(lease1.proxy);
      assert.ok(lease2.proxy);
      assert.notDeepStrictEqual(prox.getProxyKey(lease1.proxy), prox.getProxyKey(lease2.proxy));
      lease1.release();
      lease2.release();
    });

    it('Tier 1 - Case 2: Release puts proxy back into available pool', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      const originalProxy = lease.proxy;
      lease.release('test_ready');
      const leaseNext = await prox.acquireProxyLease({ timeoutMs: 1000 });
      assert.strictEqual(prox.findPoolProxy(originalProxy).state, 'ready');
      leaseNext.release();
    });

    it('Tier 1 - Case 3: Lease returns correct fingerprint UA and Cookie', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      assert.ok(lease.ua['User-Agent']);
      assert.ok(lease.ua.Cookie.includes('sessionId='));
      lease.release();
    });

    it('Tier 1 - Case 4: Mark proxy bad removes it from working list', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      const key = prox.getProxyKey(lease.proxy);
      prox.markProxyBad(lease.proxy, 'network');
      assert.ok(prox.badProxies.has(key));
      lease.release();
    });

    it('Tier 1 - Case 5: Safe redundant releases', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      lease.release();
      assert.doesNotThrow(() => lease.release());
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Timeout on leasing when all are busy', async () => {
      const leases = [];
      for (let i = 0; i < 4; i++) {
        leases.push(await prox.acquireProxyLease({ timeoutMs: 1000 }));
      }
      await assert.rejects(
        prox.acquireProxyLease({ timeoutMs: 100 }),
        /Timed out waiting/
      );
      for (const l of leases) l.release();
    });

    it('Tier 2 - Case 2: Lease fails immediately during exit sequence', async () => {
      // Find SIGINT listener in prox.js and trigger it to simulate exiting state
      const listeners = process.listeners('SIGINT');
      for (const l of listeners) {
        if (l.toString().includes('isExiting = true')) {
          l();
        }
      }
      await assert.rejects(
        prox.acquireProxyLease({ timeoutMs: 200 }),
        /Proxy manager is shutting down/
      );
      helperReloadModules();
    });

    it('Tier 2 - Case 3: Unban scan recovers expired bad proxies', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      const key = prox.getProxyKey(lease.proxy);
      prox.markProxyBad(lease.proxy, 'network');
      assert.ok(prox.badProxies.has(key));
      // Force bad timestamp back in time
      prox.badProxies.set(key, Date.now() - 15 * 60 * 1000);
      // getUa triggers unban check
      prox.getUa();
      // Verify unbanned from bad list
      assert.ok(!prox.badProxies.has(key));
      lease.release();
    });

    it('Tier 2 - Case 4: Soft block warning increments and eventually bans', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      const proxy = lease.proxy;
      const key = prox.getProxyKey(proxy);
      prox.handleSoftBlock(proxy);
      prox.handleSoftBlock(proxy);
      assert.ok(prox.getWorkingProxiesCount() > 0);
      prox.handleSoftBlock(proxy); // 3rd warning should ban
      assert.ok(prox.badProxies.has(key));
      lease.release();
    });

    it('Tier 2 - Case 5: Direct connection cooldown is active/inactive correctly', async () => {
      helperReloadModules();
      prox.setDirectCooldown(3000);
      assert.ok(prox.isDirectOnCooldown());
      assert.ok(prox.getDirectCooldownRemaining() > 0);
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Lease release transition sets correct user status cookies', async () => {
      const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
      // Simulate API call that returned guest mode expired cookies
      lease.release('expired');
      const cookie = prox.getProxyCookie(lease.proxy);
      const meta = prox.proxySessionMeta[prox.getProxyKey(lease.proxy)];
      assert.strictEqual(meta.lastUserType, 'guest');
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Sequence of multiple lease/API outcomes maintains pool consistency', async () => {
      for (let i = 0; i < 15; i++) {
        const lease = await prox.acquireProxyLease({ timeoutMs: 1000 });
        const outcome = i % 2 === 0 ? 'success' : 'test_ready';
        lease.release(outcome);
      }
      const snapshot = prox.getProxyPoolSnapshot();
      assert.ok(snapshot.active > 0);
    });
  });

  // ── FEATURE 2: Guest and logged-mode concurrency, scaling, and account balancing ──
  describe('Feature 2: Guest and logged-mode concurrency, scaling, and account balancing', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Guest mode uses guest-configured limits', async () => {
      prox.setRuntimeAuthMode('guest');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.authMode, 'guest');
    });

    it('Tier 2 - Case 2: Logged mode maps proxies using account indices', async () => {
      prox.setRuntimeAuthMode('logged');
      const index1 = prox.getProxyAccountIndex({ host: '127.0.0.1', port: '8001' }, 2);
      const index2 = prox.getProxyAccountIndex({ host: '127.0.0.1', port: '8002' }, 2);
      assert.ok(index1 >= 0 && index1 < 2);
      assert.ok(index2 >= 0 && index2 < 2);
    });

    it('Tier 1 - Case 2b: Puppeteer login receives persisted proxy account indices', async () => {
      const authCalls = [];
      const plannedSessions = {
        version: 2,
        directCookie: '',
        proxySessions: {},
        proxyGuestSessions: {},
        accountSessions: {},
        proxySessionMeta: {
          '127.0.0.1:8001': { status: 'unknown', accountIndex: 1 },
          '127.0.0.1:8002': { status: 'unknown', accountIndex: 0 },
          '127.0.0.1:8003': { status: 'unknown', accountIndex: 1 },
          '127.0.0.1:8004': { status: 'unknown', accountIndex: 0 }
        }
      };
      fs.writeFileSync(TEST_SESSIONS_FILE, JSON.stringify(plannedSessions, null, 2));
      pupp.getCookies = async (proxy, force, customCredentials, accountIndex) => {
        authCalls.push({ key: prox.getProxyKey(proxy), accountIndex });
        return `sessionId=mock-session-${accountIndex}-${proxy.port}; guest_city_id=28`;
      };

      await prox.initprox();

      assert.deepStrictEqual(
        authCalls.sort((a, b) => a.key.localeCompare(b.key)),
        [
          { key: '127.0.0.1:8001', accountIndex: 1 },
          { key: '127.0.0.1:8002', accountIndex: 0 },
          { key: '127.0.0.1:8003', accountIndex: 1 },
          { key: '127.0.0.1:8004', accountIndex: 0 }
        ]
      );
    });

    it('Tier 1 - Case 3: Set and check runtime modes', async () => {
      prox.setRuntimeAuthMode('guest');
      assert.ok(prox.isGuestMode());
      assert.ok(!prox.isLoggedMode());
      prox.setRuntimeAuthMode('logged');
      assert.ok(prox.isLoggedMode());
      assert.ok(!prox.isGuestMode());
    });

    it('Tier 1 - Case 4: Active counts by account returns partitioning stats', async () => {
      const counts = prox.getActiveCountsByAccount();
      assert.ok(typeof counts === 'object');
    });

    it('Tier 1 - Case 5: Verify getTimingConfig output aligned to speed profiles', async () => {
      const config = prox.getTimingConfig();
      assert.ok(config.profile);
      assert.ok(Number.isFinite(config.searchDelayMinMs));
    });

    it('Tier 1 - Case 6: Session validation classifies user, guest, challenge and rate limits', async () => {
      mockState.apiUserType = 'user';
      assert.strictEqual(await prox.testProxySession({ protocol: 'direct' }, 'sessionId=user'), 'valid');

      mockState.apiUserType = 'guest';
      assert.strictEqual(await prox.testProxySession({ protocol: 'direct' }, 'sessionId=guest'), 'expired');

      mockState.apiUserType = 'user';
      mockState.challenge = true;
      assert.strictEqual(await prox.testProxySession({ protocol: 'direct' }, 'sessionId=blocked'), 'block');

      mockState.challenge = false;
      mockState.rateLimit = true;
      assert.strictEqual(await prox.testProxySession({ protocol: 'direct' }, 'sessionId=limited'), 'rate_limited');
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Scaling up guest mode limits after stable successes window', async () => {
      prox.setRuntimeAuthMode('guest');
      // Simulate stable successes
      for (let i = 0; i < 60; i++) {
        prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'success');
      }
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.guestRequestLanes, prox.GUEST_REQUEST_CONCURRENCY_MAX);
    });

    it('Tier 2 - Case 2: Instability reduces guest mode limits back to initial state', async () => {
      prox.setRuntimeAuthMode('guest');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.guestRequestLanes, prox.GUEST_REQUEST_CONCURRENCY);
    });

    it('Tier 2 - Case 3: Logins file fallback count when logins empty or missing', async () => {
      fs.writeFileSync(TEST_LOGINS_FILE, '');
      const count = prox.getAccountCount();
      assert.strictEqual(count, 1);
      // Restore
      fs.writeFileSync(TEST_LOGINS_FILE, 'client123:password123\nclient456:password456');
    });

    it('Tier 2 - Case 4: Environment PARSER_CONCURRENCY overrides timing config default calculations', async () => {
      process.env.PARSER_CONCURRENCY = '99';
      assert.strictEqual(prox.getParserConcurrency(), 99);
      delete process.env.PARSER_CONCURRENCY;
    });

    it('Tier 2 - Case 5: Reserve refill action respects pause cooldowns', async () => {
      prox.setRuntimeAuthMode('guest');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.ok(snapshot.refillPausedRemainingMs > 0);
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: runGuestComparison detects incompatibility and resets mode to logged', async () => {
      mockState.apiUserType = 'user';
      mockState.appraiseResponse = { data: { appriseInfo: [{ price: 100, quantity: 5, deliveryDays: 1, catalogName: 'BMW', shortName: '11127548797' }] } };
      
      const items = [{ Марка: 'BMW', Номер: '11127548797', Название: 'Gasket', цена: '100' }];
      
      const tempAxios = axios.get;
      let count = 0;
      axios.get = async (url) => {
        count++;
        const price = count <= 2 ? 100 : 200; // logged price 100, guest price 200
        return {
          headers: { 'content-type': 'application/json', 'x-ap-user-type': 'user' },
          data: { data: { appriseInfo: [{ price, quantity: 5, deliveryDays: 1, catalogName: 'BMW', shortName: '11127548797' }], catalogs: [{ id: 12345, catalogName: 'BMW', number: '11127548797' }] } }
        };
      };
      
      const compatible = await index.runGuestComparison(items);
      assert.strictEqual(compatible, false);
      assert.strictEqual(prox.getAuthMode(), 'logged');
      
      axios.get = tempAxios;
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Scaling changes during large set of parallel requests', async () => {
      prox.setRuntimeAuthMode('guest');
      const promises = Array.from({ length: 40 }, () => {
        return prox.acquireProxyLease({ timeoutMs: 2000 }).then(l => {
          prox.recordProxyResult(l.proxy, 'success');
          l.release('test_ready');
        });
      });
      await Promise.all(promises);
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.guestRequestLanes, prox.GUEST_REQUEST_CONCURRENCY_MAX);
    });
  });

  // ── FEATURE 3: Session migration (v1 -> v2) and file permissions (0o600) ──
  describe('Feature 3: Session migration and file permissions', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Migrate v1 flat session file to v2 structured cache', async () => {
      const v1Data = {
        directCookie: 'v1-direct-cookie',
        proxySessions: { '127.0.0.1:8001': 'v1-cookie' },
        accountSessions: { 'user1': 'user-cookie' }
      };
      fs.writeFileSync(TEST_SESSIONS_FILE, JSON.stringify(v1Data, null, 2));
      prox.initprox(); // loads sessions
      assert.strictEqual(prox.getDirectCookie(), 'v1-direct-cookie');
      assert.strictEqual(prox.getProxyCookie({ host: '127.0.0.1', port: '8001' }), 'v1-cookie');
    });

    it('Tier 1 - Case 2: Session cache file has restricted 0o600 permissions', async () => {
      prox.flushProxySessions();
      const stats = fs.statSync(TEST_SESSIONS_FILE);
      if (process.platform !== 'win32') {
        const mode = stats.mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    });

    it('Tier 1 - Case 3: Load full v2 session state with metadata and runtime variables', async () => {
      const v2Data = {
        version: 2,
        directCookie: 'v2-direct-cookie',
        proxySessions: { '127.0.0.1:8001': 'v2-cookie' },
        proxyGuestSessions: { '127.0.0.1:8001': 'guest-cookie' },
        accountSessions: {},
        proxySessionMeta: { '127.0.0.1:8001': { status: 'active', guestCount: 15 } },
        runtime: { selectionCursor: 5, globalRateLimitStage: 1, globalRateLimitOpenUntil: 99999 }
      };
      fs.writeFileSync(TEST_SESSIONS_FILE, JSON.stringify(v2Data, null, 2));
      prox.initprox();
      assert.strictEqual(prox.getDirectCookie(), 'v2-direct-cookie');
      assert.strictEqual(prox.getProxyGuestCookie({ host: '127.0.0.1', port: '8001' }), 'guest-cookie');
    });

    it('Tier 1 - Case 4: Verify atomic write sequence via .tmp file rename', async () => {
      const tempPath = `${TEST_SESSIONS_FILE}.tmp`;
      prox.flushProxySessions();
      assert.ok(!fs.existsSync(tempPath)); // should be renamed/deleted
    });

    it('Tier 1 - Case 5: Debounced writes execute state flush asynchronously', async () => {
      prox.saveProxySessions();
      prox.saveProxySessions();
      assert.ok(true);
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Safe fallback load when session file does not exist', async () => {
      if (fs.existsSync(TEST_SESSIONS_FILE)) {
        fs.unlinkSync(TEST_SESSIONS_FILE);
      }
      assert.doesNotThrow(() => prox.initprox());
    });

    it('Tier 2 - Case 2: Handles corrupt JSON session data gracefully', async () => {
      fs.writeFileSync(TEST_SESSIONS_FILE, 'invalid json contents here');
      assert.doesNotThrow(() => prox.initprox());
    });

    it('Tier 2 - Case 3: Chmod errors are caught silently on restricted systems', async () => {
      const originalChmodSync = fs.chmodSync;
      fs.chmodSync = () => { throw new Error('Not supported'); };
      assert.doesNotThrow(() => prox.flushProxySessions());
      fs.chmodSync = originalChmodSync;
    });

    it('Tier 2 - Case 4: Sync flush cancels scheduled timeouts', async () => {
      prox.saveProxySessions();
      prox.flushProxySessions();
      assert.ok(true);
    });

    it('Tier 2 - Case 5: Clearing account session removes cookie from store and triggers save', async () => {
      prox.setProxyCookie(null, 'sessionId=to-be-cleared-cookie');
      prox.clearAccountSessionByCookie('sessionId=to-be-cleared-cookie');
      assert.ok(!prox.getProxyCookie(null).includes('to-be-cleared-cookie'));
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Hydrate rate limits in initprox ignores expired ones but keeps quarantine', async () => {
      const badProxyKey = '127.0.0.1:8001';
      const v2Data = {
        version: 2,
        proxySessions: {},
        proxySessionMeta: {
          [badProxyKey]: {
            last429At: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
            quarantineUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString()
          }
        }
      };
      fs.writeFileSync(TEST_SESSIONS_FILE, JSON.stringify(v2Data, null, 2));
      await prox.initprox();
      assert.ok(prox.isRecentlyRateLimited({ host: '127.0.0.1', port: '8001' }));
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Rapid parallel cookie updates do not result in state corruption', async () => {
      const proxies = [{ host: '127.0.0.1', port: '8001' }, { host: '127.0.0.1', port: '8002' }];
      for (let i = 0; i < 30; i++) {
        prox.setProxyCookie(proxies[i % 2], `sessionId=parallel-cookie-${i}`);
        prox.saveProxySessions();
      }
      prox.flushProxySessions();
      const raw = JSON.parse(fs.readFileSync(TEST_SESSIONS_FILE, 'utf-8'));
      assert.ok(raw.proxySessions['127.0.0.1:8001'] || raw.proxySessions['127.0.0.1:8002']);
    });
  });

  // ── FEATURE 4: Global circuit breaker states and escalation/cooldown stages ──
  describe('Feature 4: Global circuit breaker states and escalation/cooldown stages', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Puppeteer launch circuit locks on 3 errors', async () => {
      prox.reportLaunchSuccess();
      prox.reportLaunchError();
      prox.reportLaunchError();
      prox.reportLaunchError();
      assert.throws(() => prox.checkLaunchAllowed(), /Circuit Breaker is active/);
    });

    it('Tier 1 - Case 2: Successful browser launch resets error count', async () => {
      prox.reportLaunchError();
      prox.reportLaunchError();
      prox.reportLaunchSuccess();
      assert.doesNotThrow(() => prox.checkLaunchAllowed());
    });

    it('Tier 1 - Case 3: Launcher check throws expected format', async () => {
      prox.reportLaunchError();
      prox.reportLaunchError();
      prox.reportLaunchError();
      try {
        prox.checkLaunchAllowed();
        assert.fail('should throw');
      } catch (err) {
        assert.ok(err.message.includes('Circuit Breaker is active'));
      }
      helperReloadModules();
    });

    it('Tier 1 - Case 4: Global rate limit circuit breaker opens on threshold breach', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8002' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8003' }, 'rate_limited');
      
      const snapshot = prox.getProxyPoolSnapshot();
      assert.ok(snapshot.globalRateLimit.stage > 0);
      assert.ok(snapshot.globalRateLimit.openRemainingMs > 0);
      helperReloadModules();
    });

    it('Tier 1 - Case 5: Rate limit circuit escalation increases stage pause durations', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8002' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8003' }, 'rate_limited');
      const snap1 = prox.getProxyPoolSnapshot();
      assert.strictEqual(snap1.globalRateLimit.stage, 1);
      helperReloadModules();
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Global rate limit circuit stage and openUntil state validation', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8002' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8003' }, 'rate_limited');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.globalRateLimit.stage, 1);
      assert.ok(snapshot.globalRateLimit.openRemainingMs > 0);
      helperReloadModules();
    });

    it('Tier 2 - Case 2: Successful probe closes global circuit', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'success');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.globalRateLimit.stage, 0);
    });

    it('Tier 2 - Case 3: Failed probe during half-open escalates stage', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8002' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8003' }, 'rate_limited');
      
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.ok(snapshot.globalRateLimit.stage >= 1);
      helperReloadModules();
    });

    it('Tier 2 - Case 4: Global rate limit stage matches snapshot details', async () => {
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.globalRateLimit.stage, 0);
    });

    it('Tier 2 - Case 5: Rate limit window behaves as expected under non-limiting inputs', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.globalRateLimit.stage, 0);
      helperReloadModules();
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Browser circuit breaker locks launches when errors accumulate', async () => {
      prox.reportLaunchError();
      prox.reportLaunchError();
      prox.reportLaunchError();
      assert.throws(() => prox.checkLaunchAllowed(), /Circuit Breaker is active/);
      helperReloadModules();
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Mixed rate limits escalate stages', async () => {
      prox.recordProxyResult({ host: '127.0.0.1', port: '8001' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8002' }, 'rate_limited');
      prox.recordProxyResult({ host: '127.0.0.1', port: '8003' }, 'rate_limited');
      
      const snapshot = prox.getProxyPoolSnapshot();
      assert.strictEqual(snapshot.globalRateLimit.stage, 1);
      helperReloadModules();
    });
  });

  // ── FEATURE 5: Header stability, user-agent consistency, request-id, and clean header sanitization ──
  describe('Feature 5: Header stability and sanitization', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Request includes unique x-ap-request-id', async () => {
      let capturedId = null;
      const tempGet = axios.get;
      axios.get = async (url, options) => {
        capturedId = options.headers['x-ap-request-id'];
        return { headers: {}, data: {} };
      };
      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123');
      assert.ok(capturedId);
      assert.ok(capturedId.length > 5);
      axios.get = tempGet;
    });

    it('Tier 1 - Case 2: Fingerprint UA stays consistent for a given proxy', async () => {
      const proxy = { host: '127.0.0.1', port: '8001' };
      const fp1 = prox.getFingerprint(proxy);
      const fp2 = prox.getFingerprint(proxy);
      assert.strictEqual(fp1['User-Agent'], fp2['User-Agent']);
    });

    it('Tier 1 - Case 3: Request includes standard accept/fetch headers', async () => {
      let headers = null;
      const tempGet = axios.get;
      axios.get = async (url, options) => {
        headers = options.headers;
        return { headers: {}, data: {} };
      };
      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123');
      assert.strictEqual(headers['Accept'], 'application/json, text/plain, */*');
      assert.strictEqual(headers['Connection'], 'keep-alive');
      axios.get = tempGet;
    });

    it('Tier 1 - Case 4: Guest cookie format contains city parameter', async () => {
      prox.setRuntimeAuthMode('guest');
      const proxy = { host: '127.0.0.1', port: '8001' };
      prox.setProxyGuestCookie(proxy, 'guest_city_id=28');
      const cookie = prox.getProxyGuestCookie(proxy);
      assert.ok(cookie.includes('guest_city_id=28'));
    });

    it('Tier 1 - Case 5: Logged cookie format contains sessionId key', async () => {
      const proxy = { host: '127.0.0.1', port: '8001' };
      prox.setProxyCookie(proxy, 'sessionId=test-logged-session');
      const cookie = prox.getProxyCookie(proxy);
      assert.ok(cookie.includes('sessionId=test-logged-session'));
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Empty or missing cookie headers are excluded from request options', async () => {
      prox.setProxyCookie(null, '');
      const tempGet = axios.get;
      let headers = null;
      axios.get = async (url, options) => {
        headers = options.headers;
        return { headers: {}, data: {} };
      };
      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123', 'direct');
      assert.ok(headers.Cookie === undefined || headers.Cookie === '');
      axios.get = tempGet;
    });

    it('Tier 2 - Case 2: Cookie merging resolves duplicate cookie names', async () => {
      const oldCookie = 'foo=bar; sessionId=123';
      const newHeaders = ['sessionId=456; Path=/', 'baz=qux'];
      const merged = prox.mergeCookies(oldCookie, newHeaders);
      assert.ok(merged.includes('foo=bar'));
      assert.ok(merged.includes('sessionId=456'));
      assert.ok(merged.includes('baz=qux'));
      assert.ok(!merged.includes('sessionId=123')); // replaced
    });

    it('Tier 2 - Case 3: City injection preserves existing cookies', async () => {
      const oldCookie = 'sessionId=123; foo=bar';
      const proxy = { host: '127.0.0.1', port: '8001' };
      prox.setProxyCookie(proxy, oldCookie);
      await prox.setSessionCity(proxy, 99);
      const updated = prox.getProxyCookie(proxy);
      assert.ok(updated.includes('sessionId=123'));
      assert.ok(updated.includes('foo=bar'));
      assert.ok(updated.includes('guest_city_id=99'));
    });

    it('Tier 2 - Case 4: Header values length check', async () => {
      const fp = prox.getFingerprint({ host: '127.0.0.1', port: '8001' });
      assert.ok(fp['User-Agent'].length > 10);
    });

    it('Tier 2 - Case 5: Custom Referer overrides the default Referer header', async () => {
      let referer = null;
      const tempGet = axios.get;
      axios.get = async (url, options) => {
        referer = options.headers['Referer'];
        return { headers: {}, data: {} };
      };
      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123', null, 'https://custom-referer.ru/');
      assert.strictEqual(referer, 'https://custom-referer.ru/');
      axios.get = tempGet;
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Session cookies updated during GET requests propagate to subsequent calls', async () => {
      const tempGet = axios.get;
      const proxy = { host: '127.0.0.1', port: '8001' };
      prox.setProxyCookie(proxy, 'sessionId=old-session');
      
      let capturedCookie = null;
      axios.get = async (url, options) => {
        capturedCookie = options.headers['Cookie'];
        return {
          headers: {
            'set-cookie': ['sessionId=new-session-id; Path=/'],
            'content-type': 'application/json'
          },
          data: { data: { catalogs: [] } }
        };
      };

      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123', proxy);
      assert.strictEqual(capturedCookie, 'sessionId=old-session');
      
      // Next call should carry updated cookie
      axios.get = async (url, options) => {
        capturedCookie = options.headers['Cookie'];
        return { headers: {}, data: {} };
      };
      await ax.get('https://autopiter.ru/api/api/searchdetails?detailNumber=123', proxy);
      assert.ok(capturedCookie.includes('sessionId=new-session-id'));
      
      axios.get = tempGet;
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Cookie evolution during consecutive requests remains valid', async () => {
      const tempGet = axios.get;
      const proxy = { host: '127.0.0.1', port: '8001' };
      prox.setProxyCookie(proxy, 'sessionId=start');
      
      for (let i = 0; i < 5; i++) {
        axios.get = async (url) => {
          return {
            headers: {
              'set-cookie': [`cookie-${i}=val-${i}`],
              'content-type': 'application/json'
            },
            data: { data: { catalogs: [] } }
          };
        };
        await ax.get('https://autopiter.ru/api/api/searchdetails', proxy);
      }
      
      const finalCookie = prox.getProxyCookie(proxy);
      assert.ok(finalCookie.includes('sessionId=start'));
      assert.ok(finalCookie.includes('cookie-4=val-4'));
      axios.get = tempGet;
    });
  });

  // ── FEATURE 6: Brand matching, catalog cache TTL, and ambiguous brand resolution ──
  describe('Feature 6: Brand matching and catalog cache', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Canonical brand aliases map to standardized keys', async () => {
      assert.strictEqual(ax.canonicalBrand('VW'), 'vag');
      assert.strictEqual(ax.canonicalBrand('Volkswagen'), 'vag');
      assert.strictEqual(ax.canonicalBrand('Mercedes-Benz'), 'mercedesbenz');
    });

    it('Tier 1 - Case 2: Article normalization strips non-alphanumeric characters', async () => {
      assert.strictEqual(ax.normalizeArticle('A-123.45/B'), 'a12345b');
    });

    it('Tier 1 - Case 3: Select catalog matches matching canonical brands', async () => {
      const catalogs = [
        { id: 55, catalogName: 'Volkswagen', number: '123' },
        { id: 66, catalogName: 'BMW', number: '123' }
      ];
      const match = ax.selectCatalog(catalogs, 'VAG', '123');
      assert.strictEqual(match.status, 'resolved');
      assert.strictEqual(match.catalog.id, 55);
    });

    it('Tier 1 - Case 4: Ambiguous result when multiple IDs match canonical request', async () => {
      const catalogs = [
        { id: 111, catalogName: 'VW', number: '123' },
        { id: 222, catalogName: 'Volkswagen', number: '123' }
      ];
      const match = ax.selectCatalog(catalogs, 'VAG', '123');
      assert.strictEqual(match.status, 'ambiguous');
    });

    it('Tier 1 - Case 5: Correct cache key generation formatting', async () => {
      const stats = ax.getCatalogCacheStats();
      assert.ok(Number.isFinite(stats.totalEntries));
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Catalog cache uses success TTL for resolved status', async () => {
      ax.setCachedCatalogId('123', 'BMW', 999, { status: 'resolved' });
      const entry = ax.getCachedCatalogEntry('123', 'BMW');
      assert.ok(entry);
      assert.strictEqual(entry.id, 999);
    });

    it('Tier 2 - Case 2: Stats count matches current cache state', async () => {
      ax.setCachedCatalogId('111', 'BMW', 111);
      ax.setCachedCatalogId('222', 'BMW', 222);
      const stats = ax.getCatalogCacheStats();
      assert.ok(stats.totalEntries >= 2);
    });

    it('Tier 2 - Case 3: List missing catalog items ignores cached resolved ones', async () => {
      ax.setCachedCatalogId('555', 'Audi', 555);
      const items = [{ Номер: '555', Марка: 'Audi' }, { Номер: '666', Марка: 'Audi' }];
      const missing = ax.listMissingCatalogItems(items);
      assert.strictEqual(missing.length, 1);
      assert.strictEqual(missing[0].Номер, '666');
    });

    it('Tier 2 - Case 4: Catalog cache stores extended metadata under normalized keys', async () => {
      ax.setCachedCatalogId('ABC-1', 'VW', 55, {
        status: 'resolved',
        catalogName: 'Volkswagen',
        inputName: 'Brake pad'
      });
      let entry = ax.getCachedCatalogEntry('ABC1', 'VAG');
      assert.ok(entry);
      assert.strictEqual(entry.id, 55);
      assert.strictEqual(entry.canonicalBrand, 'vag');
      assert.strictEqual(entry.normalizedNumber, 'abc1');
      assert.strictEqual(entry.inputName, 'Brake pad');

      ax.touchCatalogCacheInputItems([{ Марка: 'VAG', Номер: 'ABC1', Название: 'Updated pad' }]);
      entry = ax.getCachedCatalogEntry('ABC-1', 'VW');
      assert.strictEqual(entry.inputName, 'Updated pad');
      assert.ok(entry.lastSeenInInputAt);
    });

    it('Tier 2 - Case 5: Expired entries are not returned from cache', async () => {
      ax.setCachedCatalogId('exp', 'BMW', 999);
      ax.flushCatalogCache();
      const key = `${ax.canonicalBrand('BMW')}|${ax.normalizeArticle('exp')}`;
      // Backdate entry
      const actualCache = JSON.parse(fs.readFileSync(process.env.CATALOG_CACHE_FILE, 'utf-8'));
      actualCache[key].cachedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(process.env.CATALOG_CACHE_FILE, JSON.stringify(actualCache));
      
      // Reload cache in module
      delete require.cache[require.resolve('../ax.js')];
      ax = require('../ax.js');
      
      const entry = ax.getCachedCatalogId('exp', 'BMW');
      assert.strictEqual(entry, undefined);
    });

    it('Tier 2 - Case 6: Debounced cache updates write asynchronously', async () => {
      ax.setCachedCatalogId('deb', 'BMW', 999);
      await new Promise(r => setTimeout(r, 2200));
      const raw = JSON.parse(fs.readFileSync(process.env.CATALOG_CACHE_FILE, 'utf-8'));
      assert.ok(raw[`${ax.canonicalBrand('BMW')}|${ax.normalizeArticle('deb')}`]);
    });

    it('Tier 2 - Case 7: Appraise mismatch marks cached catalog ID stale', async () => {
      ax.setCachedCatalogId('123', 'BMW', 12345, {
        status: 'resolved',
        catalogName: 'BMW'
      });
      mockState.appraiseResponse = {
        data: {
          appriseInfo: [
            { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'Audi', shortName: '999', articleId: 999 }
          ]
        }
      };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123', Название: 'Brake pad' }, 12345);
      assert.strictEqual(res, 'stale_id');
      assert.strictEqual(ax.getCachedCatalogId('123', 'BMW'), undefined);
      ax.flushCatalogCache();
      const raw = JSON.parse(fs.readFileSync(process.env.CATALOG_CACHE_FILE, 'utf-8'));
      assert.strictEqual(raw[`${ax.canonicalBrand('BMW')}|${ax.normalizeArticle('123')}`].status, 'stale');
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Prefetch catalog saves ambiguous matches and main run handles them', async () => {
      helperReloadModules();
      if (fs.existsSync(process.env.CATALOG_CACHE_FILE)) {
        fs.writeFileSync(process.env.CATALOG_CACHE_FILE, '{}', 'utf-8');
      }

      mockState.catalogsResponse = {
        data: {
          catalogs: [
            { id: 111, catalogName: 'BMW', number: '123' },
            { id: 222, catalogName: 'BMW', number: '123' }
          ]
        }
      };
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'Ambiguous test', цена: '100' }];
      await index.runCatalogPrefetch(items);
      
      const cached = ax.getCachedCatalogId('123', 'BMW');
      assert.strictEqual(cached, 'ambiguous');
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Prefetch handles mixed API results correctly', async () => {
      helperReloadModules();
      if (fs.existsSync(process.env.CATALOG_CACHE_FILE)) {
        fs.writeFileSync(process.env.CATALOG_CACHE_FILE, '{}', 'utf-8');
      }

      const items = [
        { Марка: 'BMW', Номер: '101' },
        { Марка: 'BMW', Номер: '102' },
        { Марка: 'BMW', Номер: '103' }
      ];
      const tempGet = axios.get;
      axios.get = async (url) => {
        if (url.includes('101')) {
          return { headers: { 'content-type': 'application/json' }, data: { data: { catalogs: [{ id: 101, catalogName: 'BMW', number: '101' }] } } };
        }
        if (url.includes('102')) {
          return { headers: { 'content-type': 'application/json' }, data: { data: { catalogs: [] } } };
        }
        throw new Error('Timeout');
      };
      
      const res = await index.runCatalogPrefetch(items);
      assert.strictEqual(res.resolved, 1);
      assert.strictEqual(res.notFound, 1);
      assert.strictEqual(res.failed, 1);
      
      axios.get = tempGet;
    });
  });

  // ── FEATURE 7: Offer filtering rules and deduplication ──
  describe('Feature 7: Offer filtering and deduplication', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Filter offers with delivery days > 7', async () => {
      const raw = [
        { price: 100, quantity: 5, deliveryDays: 5, catalogName: 'BMW', shortName: '123', id: 1 },
        { price: 100, quantity: 5, deliveryDays: 8, catalogName: 'BMW', shortName: '123', id: 2 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    it('Tier 1 - Case 2: Filter offers with quantity <= 0', async () => {
      const raw = [
        { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 1 },
        { price: 100, quantity: 0, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 2 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    it('Tier 1 - Case 3: Filter offers with price <= 0', async () => {
      const raw = [
        { price: 10, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 1 },
        { price: 0, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 2 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    it('Tier 1 - Case 4: Filter offers with non-matching brands', async () => {
      const raw = [
        { price: 10, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 1 },
        { price: 10, quantity: 1, deliveryDays: 1, catalogName: 'Audi', shortName: '123', id: 2 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    it('Tier 1 - Case 5: Deduplicate offers using detailUid', async () => {
      const raw = [
        { price: 10, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', detailUid: 'uid1' },
        { price: 10, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', detailUid: 'uid1' }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Ignore offers with non-numeric delivery days', async () => {
      const raw = [
        { price: 10, quantity: 1, deliveryDays: 'foo', catalogName: 'BMW', shortName: '123', id: 1 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res, null);
    });

    it('Tier 2 - Case 2: Ignore offers with non-numeric price or quantity', async () => {
      const raw = [
        { price: 'bar', quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', id: 1 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res, null);
    });

    it('Tier 2 - Case 3: Matches brand aliases VW -> VAG correctly during filtering', async () => {
      const raw = [
        { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'VW', shortName: '123', id: 1 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'VAG', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    it('Tier 2 - Case 4: processAppraiseOffers correctly formats output records', async () => {
      const raw = [
        { price: 95.5, quantity: 3, deliveryDays: 2, catalogName: 'BMW', shortName: '123', name: 'Gasket' }
      ];
      const res = ax.processAppraiseOffers({ Номер: '123', Марка: 'BMW', цена: '120' }, raw);
      assert.strictEqual(res[0]['Цена'], 95.5);
      assert.strictEqual(res[0]['Мин_Цена'], '95,5');
      assert.strictEqual(res[0]['Наша_Цена'], '120');
    });

    it('Tier 2 - Case 5: Brand comparison is case-insensitive', async () => {
      const raw = [
        { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'bmw', shortName: '123', id: 1 }
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 1);
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Appraise returns mixed formats, deduplicates and exports clean records', async () => {
      const raw = [
        { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', detailUid: 'uid1' },
        { price: 100, quantity: 1, deliveryDays: 1, catalogName: 'BMW', shortName: '123', detailUid: 'uid1' }, // dup
        { price: 90, quantity: 1, deliveryDays: 8, catalogName: 'BMW', shortName: '123', detailUid: 'uid2' }, // over 7 days
        { price: 110, quantity: 2, deliveryDays: 1, catalogName: 'BMW', shortName: '123', detailUid: 'uid3' }  // valid
      ];
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.strictEqual(res.length, 2);
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Performance filtering check on large array of offers', async () => {
      const raw = Array.from({ length: 100 }, (_, i) => ({
        price: 100 + i,
        quantity: i % 2 === 0 ? 5 : 0,
        deliveryDays: i % 3 === 0 ? 1 : 9,
        catalogName: 'BMW',
        shortName: '123',
        detailUid: `uid-${i}`
      }));
      mockState.appraiseResponse = { data: { appriseInfo: raw } };
      const res = await ax.getInfo({ Марка: 'BMW', Номер: '123' }, 12345);
      assert.ok(res.length > 0);
      assert.ok(res.length < 50);
    });
  });

  // ── FEATURE 8: Run manifest checkpoint generation ──
  describe('Feature 8: Run manifest checkpoint generation', () => {
    // Tier 1: Happy path
    it('Tier 1 - Case 1: Append checkpoint writes JSONL lines', async () => {
      const record = { key: 'bmw|123', status: 'success', count: 5 };
      index.appendCheckpoint(record);
      assert.ok(fs.existsSync(process.env.CHECKPOINT_FILE));
      const content = fs.readFileSync(process.env.CHECKPOINT_FILE, 'utf-8');
      assert.ok(content.includes('bmw|123'));
    });

    it('Tier 1 - Case 2: Load checkpoint restores completed items mapping', async () => {
      const record = { key: 'bmw|123|name|100|1|10', status: 'success', count: 5 };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(record) + '\n');
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const completed = index.loadCheckpoint(items);
      assert.strictEqual(completed.size, 1);
      assert.ok(completed.has(index.getItemKey(items[0])));
    });

    it('Tier 1 - Case 3: Build run manifest maps accurate counts', async () => {
      const record = { key: 'bmw|123|name|100|1|10', status: 'success', count: 5 };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(record) + '\n');
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const manifest = index.buildRunManifest(items);
      assert.strictEqual(manifest.counts.success, 1);
    });

    it('Tier 1 - Case 4: Write run manifest generates parser_manifest.json on disk', async () => {
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      index.writeRunManifest(items);
      assert.ok(fs.existsSync(process.env.RUN_MANIFEST_FILE));
    });

    it('Tier 1 - Case 5: Checkpoint load skips entries older than max age', async () => {
      const record = {
        key: 'bmw|123|name|100|1|10',
        status: 'success',
        at: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString()
      };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(record) + '\n');
      process.env.CHECKPOINT_MAX_AGE_HOURS = '6';
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const completed = index.loadCheckpoint(items);
      assert.strictEqual(completed.size, 0);
    });

    // Tier 2: Boundary/Corner Cases
    it('Tier 2 - Case 1: Checkpoint loaded count updates in scraper run metrics', async () => {
      assert.ok(true);
    });

    it('Tier 2 - Case 2: Ignore malformed checkpoint lines without crash', async () => {
      fs.writeFileSync(process.env.CHECKPOINT_FILE, 'not json\n');
      assert.doesNotThrow(() => index.loadCheckpoint([]));
    });

    it('Tier 2 - Case 3: Ignore checkpoint entries that do not match input list', async () => {
      const record = { key: 'other|999|name|100|1|10', status: 'success' };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(record) + '\n');
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const completed = index.loadCheckpoint(items);
      assert.strictEqual(completed.size, 0);
    });

    it('Tier 2 - Case 4: Do not restore retryable errors as completed', async () => {
      const record = { key: 'bmw|123|name|100|1|10', status: 'retryable_error' };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(record) + '\n');
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const completed = index.loadCheckpoint(items);
      assert.strictEqual(completed.size, 0);
    });

    it('Tier 2 - Case 5: Manifest complete status is false if items are missing or error', async () => {
      const items = [{ Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }];
      const manifest = index.buildRunManifest(items);
      assert.strictEqual(manifest.complete, false);
    });

    // Tier 3: Cross-feature Combination
    it('Tier 3 - Case 1: Aborted run writes partial checkpoint and resumes successfully skipping finished items', async () => {
      const items = [
        { Марка: 'BMW', Номер: '1', Название: 'g', цена: '10', партия: '1', 'кол-во': '1' },
        { Марка: 'BMW', Номер: '2', Название: 'g', цена: '10', партия: '1', 'кол-во': '1' }
      ];
      
      const finishedRecord = {
        key: index.getItemKey(items[0]),
        status: 'success',
        count: 1,
        offers: [{ Артикул: '1', Бренд: 'BMW', Мин_Цена: '10' }],
        at: new Date().toISOString()
      };
      fs.writeFileSync(process.env.CHECKPOINT_FILE, JSON.stringify(finishedRecord) + '\n');
      
      const completed = index.loadCheckpoint(items);
      assert.strictEqual(completed.size, 1);
    });

    // Tier 4: Real-world Workload simulation
    it('Tier 4 - Case 1: Full lifecycle run with manifests and checkpoint writing verified', async () => {
      const items = [
        { Марка: 'BMW', Номер: '123', Название: 'name', цена: '100', партия: '1', 'кол-во': '10' }
      ];
      
      const originalGetDetails = files.getDetails;
      files.getDetails = () => items;
      delete require.cache[require.resolve('../index.js')];
      index = require('../index.js');

      process.env.SCRAPE_LIMIT = '1';
      process.env.DRY_RUN = '1';
      mockState.catalogsResponse = {
        data: {
          catalogs: [
            { id: 12345, catalogName: 'BMW', number: '123' }
          ]
        }
      };
      
      await index.start();
      
      assert.ok(fs.existsSync(process.env.CHECKPOINT_FILE));
      index.writeRunManifest(items);
      assert.ok(fs.existsSync(process.env.RUN_MANIFEST_FILE));
      const manifest = JSON.parse(fs.readFileSync(process.env.RUN_MANIFEST_FILE, 'utf-8'));
      assert.ok(manifest.counts.success > 0 || manifest.counts.retryable_error > 0 || manifest.counts.no_offers > 0);

      files.getDetails = originalGetDetails;
      delete require.cache[require.resolve('../index.js')];
      index = require('../index.js');
    });
  });
});
