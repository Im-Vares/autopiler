const fs = require('fs');
const path = require('path');
const { getProxies, getProxiesFilePath } = require('./files.js');
const httpProxyAgent = require('http-proxy-agent');
const httpsProxyAgent = require('https-proxy-agent');
const axios = require('axios');
let SocksProxyAgent = null;
try {
    SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (err) {
    // socks-proxy-agent is not installed yet
}

const SESSIONS_FILE = process.env.PROXY_SESSIONS_FILE
    ? path.resolve(process.env.PROXY_SESSIONS_FILE)
    : path.join(__dirname, 'proxy_sessions.json');
const DEFAULT_LOGINS_FILE = process.env.LOGINS_FILE
    ? path.resolve(process.env.LOGINS_FILE)
    : path.join(__dirname, 'logins.txt');
const PLACEHOLDER_ACCOUNT_USERS = new Set(['client123', 'client456']);

function isProductionRuntime() {
    return process.env.NODE_ENV !== 'test' && process.env.ALLOW_TEST_CONFIG !== '1';
}

function isPlaceholderAccount(account) {
    return !account || PLACEHOLDER_ACCOUNT_USERS.has(String(account.username || '').trim().toLowerCase());
}

function isLoopbackProxy(proxy) {
    const host = String(proxy?.host || '').trim().toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

let saveTimeout = null;
const proxySessionSaveTimerRegistry = global.__AUTOPITER_PROXY_SESSION_SAVE_TIMER_REGISTRY
    || (global.__AUTOPITER_PROXY_SESSION_SAVE_TIMER_REGISTRY = new Set());
const proxySessionSaveTimerHandle = {
    clear() {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
    }
};
proxySessionSaveTimerRegistry.add(proxySessionSaveTimerHandle);
function buildSessionState() {
    return {
        version: 2,
        directCookie,
        proxySessions,
        proxyGuestSessions,
        accountSessions,
        proxySessionMeta,
        runtime: {
            selectionCursor: poolSelectionCursor,
            globalRateLimitStage,
            globalRateLimitOpenUntil
        }
    };
}

function writeSessionStateAtomicSync() {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const temporaryFile = `${SESSIONS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(buildSessionState(), null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(temporaryFile, SESSIONS_FILE);
    try {
        fs.chmodSync(SESSIONS_FILE, 0o600);
    } catch (err) {
        // Best effort on filesystems without POSIX permissions.
    }
}

function saveProxySessions() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
        saveTimeout = null;
        try {
            writeSessionStateAtomicSync();
        } catch (err) {
            console.log(`[Proxy Manager] Failed to serialize proxy sessions: ${err.message}`);
        }
    }, 2000);
    if (typeof saveTimeout.unref === 'function') {
        saveTimeout.unref();
    }
}

function flushProxySessions() {
    for (const timerHandle of proxySessionSaveTimerRegistry) {
        if (timerHandle && typeof timerHandle.clear === 'function') {
            timerHandle.clear();
        }
    }
    try {
        writeSessionStateAtomicSync();
        console.log(`[Proxy Manager] Sessions flushed synchronously to disk.`);
    } catch (err) {
        console.log(`[Proxy Manager] Failed to flush proxy sessions: ${err.message}`);
    }
}

function migrateV1ToV2(data) {
    if (data && data.version === 2) {
        return data;
    }
    console.log(`[Proxy Manager] Migrating session cache from V1 to V2 format...`);
    const migrated = {
        version: 2,
        directCookie: typeof data?.directCookie === 'string' ? data.directCookie : '',
        proxySessions: {},
        proxyGuestSessions: {},
        accountSessions: {},
        proxySessionMeta: {}
    };
    if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
            if (key === 'directCookie' || key === 'proxySessions' || key === 'proxyGuestSessions' || key === 'accountSessions' || key === 'proxySessionMeta' || key === 'runtime' || key === 'version') {
                continue;
            }
            if (typeof value === 'string') {
                migrated.proxySessions[key] = value;
                migrated.proxySessionMeta[key] = {
                    proxyKey: key,
                    status: 'unknown',
                    lastUsedAt: 0,
                    quarantineUntil: null
                };
            }
        }
        if (data.proxySessions) Object.assign(migrated.proxySessions, data.proxySessions);
        if (data.proxyGuestSessions) Object.assign(migrated.proxyGuestSessions, data.proxyGuestSessions);
        if (data.accountSessions) Object.assign(migrated.accountSessions, data.accountSessions);
        if (data.proxySessionMeta) Object.assign(migrated.proxySessionMeta, data.proxySessionMeta);
    }
    return migrated;
}

function loadProxySessions() {
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            let data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
            if (!data || data.version !== 2) {
                data = migrateV1ToV2(data);
                fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
            } else {
                try {
                    fs.chmodSync(SESSIONS_FILE, 0o600);
                } catch (err) {}
            }
            if (data.directCookie !== undefined) {
                directCookie = data.directCookie;
            }
            if (data.proxySessions !== undefined) {
                for (const k in proxySessions) delete proxySessions[k];
                Object.assign(proxySessions, data.proxySessions);
            }
            if (data.proxyGuestSessions !== undefined) {
                for (const k in proxyGuestSessions) delete proxyGuestSessions[k];
                Object.assign(proxyGuestSessions, data.proxyGuestSessions);
            }
            if (data.accountSessions !== undefined) {
                for (const k in accountSessions) delete accountSessions[k];
                Object.assign(accountSessions, data.accountSessions);
            }
            if (data.proxySessionMeta !== undefined) {
                for (const k in proxySessionMeta) delete proxySessionMeta[k];
                Object.assign(proxySessionMeta, data.proxySessionMeta);
            }
            if (data.runtime && Number.isFinite(data.runtime.selectionCursor)) {
                poolSelectionCursor = data.runtime.selectionCursor;
            }
            if (data.runtime && Number.isFinite(data.runtime.globalRateLimitStage)) {
                globalRateLimitStage = data.runtime.globalRateLimitStage;
            }
            if (data.runtime && Number.isFinite(data.runtime.globalRateLimitOpenUntil)) {
                globalRateLimitOpenUntil = data.runtime.globalRateLimitOpenUntil;
            }
            console.log(`[Proxy Manager] Loaded proxy session state v${data.version || 1} from cache.`);
        }
    } catch (err) {
        console.log(`[Proxy Manager] Failed to load proxy sessions: ${err.message}`);
    }
}

function getAllAccounts() {
    try {
        const file = DEFAULT_LOGINS_FILE;
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf-8').trim();
            const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            const list = [];
            for (const line of lines) {
                const parts = line.split(':');
                if (parts.length >= 2) {
                    list.push({ username: parts[0], password: parts.slice(1).join(':') });
                }
            }
            return list;
        }
    } catch (err) {
        console.log(`[Proxy Manager] Failed to read ${DEFAULT_LOGINS_FILE}: ${err.message}`);
    }
    return [];
}

function normalizeAuthMode(mode) {
    const normalized = String(mode || 'logged').trim().toLowerCase();
    if (normalized === 'guest' || normalized === 'auto' || normalized === 'logged') {
        return normalized;
    }
    return 'logged';
}

function normalizeScrapeProfile(profile) {
    const normalized = String(profile || 'fast').trim().toLowerCase();
    if (normalized === 'safe' || normalized === 'fast' || normalized === 'turbo') {
        return normalized;
    }
    return 'fast';
}

function getScrapeProfileConfig(profile) {
    const normalized = normalizeScrapeProfile(profile);
    if (normalized === 'safe') {
        return {
            activePerAccountSafe: 3,
            activePerAccountHard: 5,
            accountRequestConcurrency: 1,
            parserConcurrencyPerAccount: 2,
            parserConcurrencyMax: 4,
            proxyCooldownMinMs: 8000,
            proxyCooldownMaxMs: 12000,
            accountIntervalMinMs: 7000,
            accountIntervalMaxMs: 10000,
            guestRequestConcurrency: 1,
            guestIntervalMinMs: 1200,
            guestIntervalMaxMs: 1800,
            searchDelayMinMs: 1800,
            searchDelayMaxMs: 3600,
            appraiseDelayMinMs: 2600,
            appraiseDelayMaxMs: 5200,
            startupJitterMs: 3000
        };
    }
    if (normalized === 'turbo') {
        return {
            activePerAccountSafe: 5,
            activePerAccountHard: 6,
            accountRequestConcurrency: 3,
            parserConcurrencyPerAccount: 5,
            parserConcurrencyMax: 16,
            proxyCooldownMinMs: 700,
            proxyCooldownMaxMs: 1800,
            accountIntervalMinMs: 1800,
            accountIntervalMaxMs: 3000,
            guestRequestConcurrency: 4,
            guestIntervalMinMs: 350,
            guestIntervalMaxMs: 700,
            searchDelayMinMs: 120,
            searchDelayMaxMs: 450,
            appraiseDelayMinMs: 180,
            appraiseDelayMaxMs: 650,
            startupJitterMs: 1000
        };
    }
    return {
        activePerAccountSafe: 3,
        activePerAccountHard: 5,
        accountRequestConcurrency: 1,
        parserConcurrencyPerAccount: 2,
        parserConcurrencyMax: 4,
        proxyCooldownMinMs: 8000,
        proxyCooldownMaxMs: 12000,
        accountIntervalMinMs: 3200,
        accountIntervalMaxMs: 4100,
        guestRequestConcurrency: 1,
        guestIntervalMinMs: 900,
        guestIntervalMaxMs: 1400,
        searchDelayMinMs: 0,
        searchDelayMaxMs: 0,
        appraiseDelayMinMs: 0,
        appraiseDelayMaxMs: 0,
        startupJitterMs: 1500
    };
}

function readPositiveIntEnv(name, fallback) {
    const value = parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getTimingConfig() {
    return {
        profile: SCRAPE_PROFILE,
        searchDelayMinMs: readPositiveIntEnv('SEARCH_DELAY_MIN_MS', PROFILE_CONFIG.searchDelayMinMs),
        searchDelayMaxMs: readPositiveIntEnv('SEARCH_DELAY_MAX_MS', PROFILE_CONFIG.searchDelayMaxMs),
        appraiseDelayMinMs: readPositiveIntEnv('APPRAISE_DELAY_MIN_MS', PROFILE_CONFIG.appraiseDelayMinMs),
        appraiseDelayMaxMs: readPositiveIntEnv('APPRAISE_DELAY_MAX_MS', PROFILE_CONFIG.appraiseDelayMaxMs),
        startupJitterMs: readPositiveIntEnv('STARTUP_JITTER_MS', PROFILE_CONFIG.startupJitterMs),
        parserConcurrencyPerAccount: Math.max(1, readPositiveIntEnv('PARSER_CONCURRENCY_PER_ACCOUNT', PROFILE_CONFIG.parserConcurrencyPerAccount)),
        parserConcurrencyMax: Math.max(1, readPositiveIntEnv('PARSER_CONCURRENCY_MAX', PROFILE_CONFIG.parserConcurrencyMax)),
        accountRequestConcurrency: ACCOUNT_REQUEST_CONCURRENCY,
        proxyCooldownMinMs: PROXY_COOLDOWN_MIN_MS,
        proxyCooldownMaxMs: PROXY_COOLDOWN_MAX_MS,
        accountIntervalMinMs: ACCOUNT_REQUEST_INTERVAL_MIN_MS,
        accountIntervalMaxMs: ACCOUNT_REQUEST_INTERVAL_MAX_MS,
        guestRequestConcurrency: GUEST_REQUEST_CONCURRENCY,
        guestIntervalMinMs: GUEST_REQUEST_INTERVAL_MIN_MS,
        guestIntervalMaxMs: GUEST_REQUEST_INTERVAL_MAX_MS
    };
}

function getParserConcurrency() {
    const explicit = parseInt(process.env.PARSER_CONCURRENCY || '', 10);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const timing = getTimingConfig();
    return Math.min(getAccountCount() * timing.parserConcurrencyPerAccount, timing.parserConcurrencyMax);
}

function setRuntimeAuthMode(mode) {
    runtimeAuthMode = normalizeAuthMode(mode);
    console.log(`[Proxy Manager] Runtime auth mode set to ${runtimeAuthMode}.`);
}

function getAuthMode() {
    return runtimeAuthMode;
}

function isGuestMode() {
    return runtimeAuthMode === 'guest';
}

function isLoggedMode() {
    return runtimeAuthMode === 'logged' || runtimeAuthMode === 'auto';
}

function getProxyKey(proxy) {
    if (!proxy) return 'direct';
    return `${proxy.host}:${proxy.port}`;
}

function hashString(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) - hash + value.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function getAccountCount() {
    return getAllAccounts().length || 1;
}

function getFallbackAccountIndex(proxy, accountCount = getAccountCount()) {
    if (!proxy) return 0;
    return hashString(getProxyKey(proxy)) % Math.max(accountCount, 1);
}

function getStoredAccountIndex(proxy, accountCount = getAccountCount()) {
    if (!proxy) return 0;
    const meta = proxySessionMeta[getProxyKey(proxy)] || proxySessionMeta[proxy.host];
    const stored = Number(meta?.accountIndex);
    if (Number.isInteger(stored) && stored >= 0 && stored < Math.max(accountCount, 1)) {
        return stored;
    }
    return null;
}

function getProxyAccountIndex(proxy, accountCount = getAccountCount()) {
    const stored = getStoredAccountIndex(proxy, accountCount);
    if (stored !== null) return stored;
    return getFallbackAccountIndex(proxy, accountCount);
}

function assignProxyAccountIndexes(allProxies, accountCount = getAccountCount()) {
    const count = Math.max(accountCount, 1);
    const assignedCounts = Array.from({ length: count }, () => 0);
    const missing = [];

    for (const proxy of allProxies) {
        if (!proxy || !proxy.host || !proxy.port) continue;
        const meta = ensureProxyMeta(proxy);
        const stored = Number(meta.accountIndex);
        if (Number.isInteger(stored) && stored >= 0 && stored < count) {
            assignedCounts[stored]++;
        } else {
            missing.push(proxy);
        }
    }

    let changed = false;
    for (const proxy of missing) {
        const min = Math.min(...assignedCounts);
        const candidates = assignedCounts
            .map((value, index) => ({ value, index }))
            .filter(item => item.value === min)
            .map(item => item.index);
        const chosen = candidates[Math.floor(Math.random() * candidates.length)] || 0;
        const meta = ensureProxyMeta(proxy);
        meta.accountIndex = chosen;
        meta.accountAssignedAt = meta.accountAssignedAt || new Date().toISOString();
        assignedCounts[chosen]++;
        changed = true;
    }

    if (changed) {
        saveProxySessions();
    }
}

function ensureProxyMeta(proxy) {
    const key = getProxyKey(proxy);
    if (!proxySessionMeta[key]) {
        proxySessionMeta[key] = {
            proxyKey: key,
            accountIndex: getFallbackAccountIndex(proxy),
            status: 'unknown',
            lastUserType: null,
            last429At: null,
            quarantineUntil: null,
            guestCount: 0,
            cookieCreatedAt: null,
            guestCookieCreatedAt: null,
            lastUsedAt: 0,
            lastSuccessAt: null,
            networkFailureCount: 0,
            fingerprintId: null
        };
    } else {
        proxySessionMeta[key] = {
            ...proxySessionMeta[key],
            proxyKey: key,
            accountIndex: getStoredAccountIndex(proxy) ?? getFallbackAccountIndex(proxy),
            status: proxySessionMeta[key].status || 'unknown',
            lastUserType: proxySessionMeta[key].lastUserType || null,
            last429At: proxySessionMeta[key].last429At || null,
            quarantineUntil: proxySessionMeta[key].quarantineUntil || null,
            guestCount: proxySessionMeta[key].guestCount || 0,
            cookieCreatedAt: proxySessionMeta[key].cookieCreatedAt || null,
            guestCookieCreatedAt: proxySessionMeta[key].guestCookieCreatedAt || null,
            lastUsedAt: proxySessionMeta[key].lastUsedAt || 0,
            lastSuccessAt: proxySessionMeta[key].lastSuccessAt || null,
            networkFailureCount: proxySessionMeta[key].networkFailureCount || 0,
            fingerprintId: proxySessionMeta[key].fingerprintId || null
        };
    }
    return proxySessionMeta[key];
}

function getExistingProxyMeta(proxy) {
    if (!proxy) return null;
    return proxySessionMeta[getProxyKey(proxy)] || proxySessionMeta[proxy.host] || null;
}

function getRecentRateLimitRemainingMs(proxy, now = Date.now()) {
    const meta = getExistingProxyMeta(proxy);
    const quarantineUntil = meta && meta.quarantineUntil ? new Date(meta.quarantineUntil).getTime() : 0;
    if (Number.isFinite(quarantineUntil) && quarantineUntil > now) {
        return quarantineUntil - now;
    }
    if (!meta || !meta.last429At) return 0;
    const last429Ts = new Date(meta.last429At).getTime();
    if (!Number.isFinite(last429Ts)) return 0;
    return Math.max(0, PERSISTENT_RATE_LIMIT_TTL_MS - (now - last429Ts));
}

function isRecentlyRateLimited(proxy) {
    return getRecentRateLimitRemainingMs(proxy) > 0;
}

function hydratePersistentRateLimits(allProxies) {
    let hydrated = 0;
    const now = Date.now();
    for (const originalProxy of allProxies) {
        if (!originalProxy.host || !originalProxy.port) continue;
        const proxy = { ...originalProxy, auth: originalProxy.auth, protocol: originalProxy.protocol || 'socks5' };
        const remaining = getRecentRateLimitRemainingMs(proxy, now);
        if (remaining > 0) {
            badProxies.set(getProxyKey(proxy), now);
            hydrated++;
        }
    }
    if (hydrated > 0) {
        console.log(`[Proxy Manager] Persistent rate-limit quarantine: ${hydrated} proxy/proxies skipped for up to ${Math.round(PERSISTENT_RATE_LIMIT_TTL_MS / 60000)}m.`);
    }
}

function updateProxyMeta(proxy, patch) {
    if (!proxy) return null;
    const meta = ensureProxyMeta(proxy);
    const accountIndex = patch && Object.prototype.hasOwnProperty.call(patch, 'accountIndex')
        ? patch.accountIndex
        : getProxyAccountIndex(proxy);
    Object.assign(meta, patch, { proxyKey: getProxyKey(proxy), accountIndex });
    saveProxySessions();
    return meta;
}

function getProxyCookie(proxy) {
    if (!proxy) return directCookie;
    const key = getProxyKey(proxy);
    return proxySessions[key] || proxySessions[proxy.host] || '';
}

function getProxyGuestCookie(proxy) {
    if (!proxy) return '';
    const key = getProxyKey(proxy);
    return proxyGuestSessions[key] || proxyGuestSessions[proxy.host] || '';
}

function setProxyGuestCookie(proxy, cookies) {
    if (!proxy) return;
    const value = cookies || '';
    proxyGuestSessions[getProxyKey(proxy)] = value;
    delete proxyGuestSessions[proxy.host];
    updateProxyMeta(proxy, {
        guestCookieCreatedAt: value ? new Date().toISOString() : null
    });
}

function setProxyCookie(proxy, cookies) {
    if (!proxy) {
        directCookie = cookies || '';
        return;
    }
    proxySessions[getProxyKey(proxy)] = cookies || null;
    delete proxySessions[proxy.host];
    updateProxyMeta(proxy, {
        cookieCreatedAt: cookies ? new Date().toISOString() : null,
        status: cookies ? 'active' : 'invalid',
        lastUserType: cookies ? 'user' : 'guest'
    });
}

function getFingerprint(proxy) {
    const meta = ensureProxyMeta(proxy);
    if (!meta.fingerprintId) {
        meta.fingerprintId = hashString(getProxyKey(proxy)) % 2 === 0 ? 'chrome-macos' : 'chrome-windows';
        saveProxySessions();
    }
    if (meta.fingerprintId === 'chrome-windows') {
        return {
            'User-Agent': process.env.API_USER_AGENT_WINDOWS || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
            'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
        };
    }
    return {
        'User-Agent': process.env.API_USER_AGENT_MACOS || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"'
    };
}

function hasUsableLoggedCookie(proxy) {
    const cookie = getProxyCookie(proxy);
    return !!cookie && cookie.includes('sessionId=');
}

function addProxyToReserve(proxy, status = 'reserve') {
    if (!proxy || !proxy.host || !proxy.port) return;
    const key = getProxyKey(proxy);
    proxy.protocol = proxy.protocol || 'socks5';
    workingProxies = workingProxies.filter(p => getProxyKey(p) !== key);
    if (!reserveProxies.find(p => getProxyKey(p) === key)) {
        reserveProxies.push(proxy);
    }
    updateProxyMeta(proxy, { status });
}

function addProxyToWorking(proxy, status = 'active') {
    if (!proxy || !proxy.host || !proxy.port) return;
    const key = getProxyKey(proxy);
    proxy.protocol = proxy.protocol || 'socks5';
    const reserveIndex = reserveProxies.findIndex(p => getProxyKey(p) === key);
    if (reserveIndex !== -1) {
        reserveProxies.splice(reserveIndex, 1);
    }
    if (!workingProxies.find(p => getProxyKey(p) === key)) {
        workingProxies.push(proxy);
    }
    updateProxyMeta(proxy, { status });
}

function getActiveCountsByAccount() {
    const counts = {};
    for (const proxy of workingProxies) {
        const key = getProxyKey(proxy);
        if (badProxies.has(key)) continue;
        const accountIndex = getProxyAccountIndex(proxy);
        counts[accountIndex] = (counts[accountIndex] || 0) + 1;
    }
    return counts;
}

function getCurrentActivePerAccountLimit() {
    return isGuestMode() ? currentGuestActiveLimit : currentActivePerAccountLimit;
}

function selectInitialProxyPools(allProxies, sessions = proxySessions, accountCount = getAccountCount(), activeLimit = currentActivePerAccountLimit, authMode = runtimeAuthMode) {
    const active = [];
    const reserve = [];
    const toAuthenticate = [];
    const activeCounts = {};
    const cachedByAccount = Array.from({ length: Math.max(accountCount, 1) }, () => []);
    const missingByAccount = Array.from({ length: Math.max(accountCount, 1) }, () => []);

    const normalizedProxies = allProxies
        .filter(proxy => proxy && proxy.host && proxy.port)
        .map(proxy => ({ ...proxy, auth: proxy.auth, protocol: 'socks5' }))
        .sort((left, right) => {
            const leftMeta = getExistingProxyMeta(left);
            const rightMeta = getExistingProxyMeta(right);
            return (leftMeta?.lastUsedAt || 0) - (rightMeta?.lastUsedAt || 0);
        });
    const cursor = normalizedProxies.length > 0 ? poolSelectionCursor % normalizedProxies.length : 0;
    const rotatedProxies = normalizedProxies.slice(cursor).concat(normalizedProxies.slice(0, cursor));

    for (const proxy of rotatedProxies) {
        const accountIndex = getProxyAccountIndex(proxy, accountCount);
        const key = getProxyKey(proxy);
        const cachedCookies = sessions[key] || sessions[proxy.host] || '';
        if (isRecentlyRateLimited(proxy)) {
            reserve.push(proxy);
            continue;
        }
        if (authMode === 'guest') {
            if (active.length < currentGuestActiveLimit) {
                active.push(proxy);
            } else {
                reserve.push(proxy);
            }
        } else if (cachedCookies && cachedCookies.includes('sessionId=')) {
            cachedByAccount[accountIndex].push(proxy);
        } else {
            missingByAccount[accountIndex].push(proxy);
        }
    }

    if (authMode === 'guest') {
        poolSelectionCursor = normalizedProxies.length > 0
            ? (cursor + active.length) % normalizedProxies.length
            : 0;
        saveProxySessions();
        return { active, reserve, toAuthenticate, activeCounts: { guest: active.length } };
    }

    for (let accountIndex = 0; accountIndex < Math.max(accountCount, 1); accountIndex++) {
        activeCounts[accountIndex] = 0;
        for (const proxy of cachedByAccount[accountIndex]) {
            if (activeCounts[accountIndex] < activeLimit) {
                active.push(proxy);
                activeCounts[accountIndex]++;
            } else {
                reserve.push(proxy);
            }
        }
        for (const proxy of missingByAccount[accountIndex]) {
            if (activeCounts[accountIndex] < activeLimit) {
                toAuthenticate.push(proxy);
                activeCounts[accountIndex]++;
            } else {
                reserve.push(proxy);
            }
        }
    }

    poolSelectionCursor = normalizedProxies.length > 0
        ? (cursor + active.length + toAuthenticate.length) % normalizedProxies.length
        : 0;
    saveProxySessions();
    return { active, reserve, toAuthenticate, activeCounts };
}

function openGlobalRateLimitCircuit() {
    globalRateLimitStage = Math.min(globalRateLimitStage + 1, GLOBAL_RATE_LIMIT_PAUSES_MS.length);
    const pauseMs = GLOBAL_RATE_LIMIT_PAUSES_MS[Math.max(0, globalRateLimitStage - 1)];
    globalRateLimitOpenUntil = Date.now() + pauseMs;
    halfOpenProbeInFlight = false;
    refillPausedUntil = Math.max(refillPausedUntil, globalRateLimitOpenUntil);
    currentGuestRequestConcurrency = 1;
    currentGuestActiveLimit = GUEST_INITIAL_ACTIVE_PROXIES;
    guestStableSuccesses = 0;
    rateLimitEvents.length = 0;
    saveProxySessions();
    console.log(`[Proxy Manager] Global rate-limit circuit opened for ${Math.round(pauseMs / 60000)}m (stage ${globalRateLimitStage}).`);
}

function recordRateLimitEvent(proxy) {
    const now = Date.now();
    rateLimitEvents.push({ key: getProxyKey(proxy), at: now });
    while (rateLimitEvents.length > 0 && now - rateLimitEvents[0].at > GLOBAL_RATE_LIMIT_WINDOW_MS) {
        rateLimitEvents.shift();
    }
    const uniqueProxyCount = new Set(rateLimitEvents.map(event => event.key)).size;
    if (uniqueProxyCount >= GLOBAL_RATE_LIMIT_THRESHOLD) {
        openGlobalRateLimitCircuit();
    }
}

async function awaitGlobalRateLimitPermission() {
    while (true) {
        const now = Date.now();
        if (now < globalRateLimitOpenUntil) {
            await new Promise(resolve => setTimeout(resolve, Math.min(globalRateLimitOpenUntil - now, 5000)));
            continue;
        }
        if (globalRateLimitStage > 0) {
            if (!halfOpenProbeInFlight) {
                halfOpenProbeInFlight = true;
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
        }
        return false;
    }
}

function reportProbeSuccess() {
    if (halfOpenProbeInFlight) {
        halfOpenProbeInFlight = false;
        globalRateLimitStage = 0;
        globalRateLimitOpenUntil = 0;
        rateLimitEvents.length = 0;
        console.log(`[Proxy Manager] Probe succeeded! Global circuit breaker closed (reset stage to 0).`);
        saveProxySessions();
    }
}

function reportProbeFailure() {
    if (halfOpenProbeInFlight) {
        halfOpenProbeInFlight = false;
        const previousStage = globalRateLimitStage;
        globalRateLimitStage = Math.min(globalRateLimitStage + 1, GLOBAL_RATE_LIMIT_PAUSES_MS.length);
        const pauseMs = GLOBAL_RATE_LIMIT_PAUSES_MS[globalRateLimitStage - 1] || 1800000;
        globalRateLimitOpenUntil = Date.now() + pauseMs;
        console.log(`[Proxy Manager] Probe failed! Global circuit breaker escalated from stage ${previousStage} to ${globalRateLimitStage}. Re-opened for ${Math.round(pauseMs / 1000)}s.`);
        saveProxySessions();
    }
}

function noteProxyInstability(proxy, reason) {
    stabilityState.successesSinceInstability = 0;
    stabilityState.lastInstabilityAt = Date.now();
    if (isGuestMode()) {
        guestStableSuccesses = 0;
        currentGuestRequestConcurrency = 1;
        currentGuestActiveLimit = GUEST_INITIAL_ACTIVE_PROXIES;
    }
    if (reason === 'rate_limited') {
        recordRateLimitEvent(proxy);
        const refillPauseMs = isGuestMode() ? GUEST_RATE_LIMIT_REFILL_PAUSE_MS : RATE_LIMIT_REFILL_PAUSE_MS;
        if (refillPauseMs > 0) {
            refillPausedUntil = Math.max(refillPausedUntil, Date.now() + refillPauseMs);
            console.log(`[Proxy Manager] Rate-limit detected. Controlled refill paused for ${Math.round(refillPauseMs / 1000)}s.`);
        }
    }
    if (reason === 'rate_limited' && RATE_LIMIT_PACING_PENALTY_MS > 0) {
        pacingPenaltyUntil = Math.max(pacingPenaltyUntil, Date.now() + RATE_LIMIT_PACING_PENALTY_MS);
        console.log(`[Proxy Manager] Rate-limit pacing penalty active for ${Math.round(RATE_LIMIT_PACING_PENALTY_MS / 1000)}s (×${RATE_LIMIT_PACING_MULTIPLIER}).`);
    }
    if (currentActivePerAccountLimit > MAX_ACTIVE_PER_ACCOUNT_SAFE) {
        currentActivePerAccountLimit = MAX_ACTIVE_PER_ACCOUNT_SAFE;
        console.log(`[Proxy Manager] Instability (${reason}) detected. Active per-account limit lowered to ${currentActivePerAccountLimit}.`);
    }
}

function recordProxyResult(proxy, result) {
    if (!proxy) return;
    const nowIso = new Date().toISOString();
    if (result === 'success') {
        const meta = updateProxyMeta(proxy, {
            status: 'ready',
            lastUserType: isGuestMode() ? 'guest' : 'user',
            lastSuccessAt: nowIso,
            networkFailureCount: 0
        });
        if (halfOpenProbeInFlight || globalRateLimitStage > 0) {
            halfOpenProbeInFlight = false;
            globalRateLimitStage = 0;
            globalRateLimitOpenUntil = 0;
            rateLimitEvents.length = 0;
            console.log(`[Proxy Manager] Global rate-limit circuit closed after a successful probe.`);
        }
        if (isGuestMode()) {
            guestStableSuccesses++;
            if (guestStableSuccesses >= GUEST_STABLE_SUCCESS_WINDOW && currentGuestRequestConcurrency < GUEST_REQUEST_CONCURRENCY_MAX) {
                currentGuestRequestConcurrency = GUEST_REQUEST_CONCURRENCY_MAX;
                currentGuestActiveLimit = GUEST_MAX_ACTIVE_PROXIES;
                console.log(`[Proxy Manager] Guest scheduler ramped to ${currentGuestRequestConcurrency} lanes and ${currentGuestActiveLimit} active proxies.`);
                refillFromReserve().catch(() => {});
            }
        }
        stabilityState.successesSinceInstability++;
        if (currentActivePerAccountLimit < MAX_ACTIVE_PER_ACCOUNT_HARD &&
            stabilityState.successesSinceInstability >= STABLE_SUCCESS_WINDOW &&
            Date.now() - stabilityState.lastInstabilityAt >= STABLE_WINDOW_MS) {
            currentActivePerAccountLimit++;
            stabilityState.successesSinceInstability = 0;
            console.log(`[Proxy Manager] Stable window reached. Active per-account limit raised to ${currentActivePerAccountLimit}.`);
        }
        return meta;
    }
    if (result === 'guest') {
        const meta = ensureProxyMeta(proxy);
        updateProxyMeta(proxy, {
            status: 'invalid',
            lastUserType: 'guest',
            guestCount: (meta.guestCount || 0) + 1
        });
        noteProxyInstability(proxy, result);
    } else if (result === 'rate_limited') {
        const quarantineUntil = new Date(Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS).toISOString();
        updateProxyMeta(proxy, {
            status: 'quarantine',
            last429At: nowIso,
            quarantineUntil
        });
        noteProxyInstability(proxy, result);
    } else if (result === 'auth_issue') {
        updateProxyMeta(proxy, {
            status: 'invalid',
            lastUserType: 'guest'
        });
        noteProxyInstability(proxy, result);
    } else if (result === 'network') {
        const meta = ensureProxyMeta(proxy);
        updateProxyMeta(proxy, {
            status: 'quarantine',
            networkFailureCount: (meta.networkFailureCount || 0) + 1
        });
    }
}

function canUseDirectFallback() {
    return !USE_PROXIES || DIRECT_FALLBACK_IN_PROXY_MODE;
}

function validateStartupConfig(allProxies, accounts) {
    if (!isProductionRuntime() || !isLoggedMode()) return;

    if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error(`Production logged mode requires real Autopiter accounts in ${DEFAULT_LOGINS_FILE}`);
    }
    const placeholders = accounts.filter(isPlaceholderAccount).map(account => account.username);
    if (placeholders.length > 0) {
        throw new Error(`Production logged mode refuses placeholder account(s): ${placeholders.join(', ')}. Restore real logins in ${DEFAULT_LOGINS_FILE}.`);
    }
    if (!Array.isArray(allProxies) || allProxies.length === 0) {
        throw new Error(`Production proxy mode requires proxies in ${getProxiesFilePath()} or PROXY_SOURCE=api.`);
    }
    const loopbacks = allProxies.filter(isLoopbackProxy).map(proxy => getProxyKey(proxy));
    if (loopbacks.length > 0) {
        throw new Error(`Production proxy mode refuses loopback/test proxy entries: ${loopbacks.slice(0, 5).join(', ')}. Restore real proxies in ${getProxiesFilePath()} or use PROXY_SOURCE=api.`);
    }
}

function validateLoggedStartupReady() {
    if (!isProductionRuntime() || !isLoggedMode() || canUseDirectFallback()) return;
    const activeLogged = workingProxies.filter(proxy => {
        if (badProxies.has(getProxyKey(proxy))) return false;
        const cookie = getProxyCookie(proxy);
        return typeof cookie === 'string' && cookie.includes('sessionId=');
    });
    if (activeLogged.length === 0) {
        throw new Error('Production logged mode has no active proxy sessions with sessionId after initialization.');
    }
}

async function acquireRequestSlot(proxy) {
    if (!proxy) {
        return () => {};
    }

    const proxyKey = getProxyKey(proxy);
    const guest = isGuestMode();
    const accountIndex = guest ? 'guest-global' : getProxyAccountIndex(proxy);
    const isProbe = await awaitGlobalRateLimitPermission();
    const laneCount = guest ? currentGuestRequestConcurrency : ACCOUNT_REQUEST_CONCURRENCY;
    const laneIndex = hashString(proxyKey) % laneCount;
    const queueKey = `${accountIndex}:${laneIndex}`;
    const previous = accountRequestQueues.get(queueKey) || Promise.resolve();
    let releaseAccount;
    const current = new Promise(resolve => { releaseAccount = resolve; });
    const queued = previous.catch(() => {}).then(() => current);
    accountRequestQueues.set(queueKey, queued);

    await previous.catch(() => {});

    const waitMs = Math.max(0, (proxyNextAvailableAt.get(proxyKey) || 0) - Date.now());
    if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    const accountWaitMs = Math.max(0, (accountRequestNextAvailableAt.get(queueKey) || 0) - Date.now());
    if (accountWaitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, accountWaitMs));
    }

    let released = false;
    return (outcome, options = {}) => {
        if (released) return;
        released = true;

        if (isProbe) {
            if (outcome === 'success') {
                reportProbeSuccess();
            } else {
                reportProbeFailure();
            }
        }

        let cooldown = PROXY_COOLDOWN_MIN_MS + Math.random() * (PROXY_COOLDOWN_MAX_MS - PROXY_COOLDOWN_MIN_MS);
        if (outcome === 'rate_limited') {
            cooldown = Math.max(cooldown, options.retryAfterMs || 30000);
        }
        proxyNextAvailableAt.set(proxyKey, Date.now() + cooldown);

        const penaltyMultiplier = Date.now() < pacingPenaltyUntil ? RATE_LIMIT_PACING_MULTIPLIER : 1;
        const minInterval = guest ? GUEST_REQUEST_INTERVAL_MIN_MS : ACCOUNT_REQUEST_INTERVAL_MIN_MS;
        const maxInterval = guest ? GUEST_REQUEST_INTERVAL_MAX_MS : ACCOUNT_REQUEST_INTERVAL_MAX_MS;
        let interval = (minInterval + Math.random() * (maxInterval - minInterval)) * penaltyMultiplier;
        if (outcome === 'rate_limited') {
            interval = Math.max(interval, options.retryAfterMs || 30000);
        }
        accountRequestNextAvailableAt.set(queueKey, Date.now() + interval);

        releaseAccount();
        if (accountRequestQueues.get(queueKey) === queued) {
            accountRequestQueues.delete(queueKey);
        }
    };
}

function clearAccountSessionByCookie(cookieStr) {
    if (!cookieStr) return;
    let cleared = false;
    for (const username in accountSessions) {
        if (accountSessions[username] === cookieStr) {
            accountSessions[username] = null;
            cleared = true;
            console.log(`[Proxy Manager] Cleared expired session for account ${username}`);
        }
    }
    for (const proxyKey in proxySessions) {
        if (proxySessions[proxyKey] === cookieStr) {
            proxySessions[proxyKey] = '';
            cleared = true;
            console.log(`[Proxy Manager] Cleared expired session cookie for proxy ${proxyKey}`);
        }
    }
    if (directCookie === cookieStr) {
        directCookie = '';
        cleared = true;
        console.log(`[Proxy Manager] Cleared expired direct connection session cookie`);
    }
    if (cleared) {
        saveProxySessions();
    }
}

async function testProxySession(proxy, cookies) {
    if (!cookies) return 'missing';
    const fingerprint = proxy && proxy.protocol !== 'direct'
        ? getFingerprint(proxy)
        : { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' };
    const axiosOptions = {
        headers: {
            'User-Agent': fingerprint['User-Agent'],
            'Accept': 'application/json, text/plain, */*',
            'Cookie': cookies,
            'Referer': 'https://autopiter.ru/'
        },
        timeout: 8000
    };

    if (proxy && proxy.protocol !== 'direct') {
        const ip = proxy.host;
        const port = proxy.port;
        const username = proxy.auth ? proxy.auth.username : '';
        const pass = proxy.auth ? proxy.auth.password : '';

        if (proxy.protocol === 'socks5' && SocksProxyAgent) {
            const socksUrl = `socks5h://${encodeURIComponent(username)}:${encodeURIComponent(pass)}@${ip}:${port}`;
            axiosOptions.httpAgent = new SocksProxyAgent(socksUrl);
            axiosOptions.httpsAgent = axiosOptions.httpAgent;
        } else {
            const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(pass)}@${ip}:${port}`;
            axiosOptions.httpAgent = new httpProxyAgent.HttpProxyAgent(proxyUrl);
            axiosOptions.httpsAgent = new httpsProxyAgent.HttpsProxyAgent(proxyUrl);
        }
    }

    try {
        const res = await axios.get('https://autopiter.ru/api/api/searchdetails?meta[frontendType]=1&meta[renderType]=1&meta[routeId]=APPRAISE_CATALOGS&detailNumber=AAT024&isFullQuery=true', axiosOptions);
        const apiUserType = res.headers['x-ap-user-type'];
        const isHtml = res.headers['content-type'] && res.headers['content-type'].includes('text/html');
        const isChallenge = isHtml && (
            res.data && (
                typeof res.data === 'string' && (
                    res.data.includes('challenge') || 
                    res.data.includes('cloudflare') || 
                    res.data.includes('__js_p_') ||
                    res.data.includes('captcha') ||
                    res.data.includes('Вы очень активный!') ||
                    res.data.includes('Я не робот!')
                )
            )
        );

        if (isChallenge) {
            return 'block';
        }
        if (apiUserType === 'guest') {
            return 'expired';
        }
        if (apiUserType !== 'user') {
            return 'unauthorized';
        }
        if (res.data && res.data.error) {
            return 'error';
        }
        return 'valid';
    } catch (err) {
        if (err.response) {
            if (err.response.status === 429) {
                return 'rate_limited';
            }
            if (err.response.status === 403) {
                return 'forbidden';
            }
            if (err.response.status === 401) {
                return 'unauthorized';
            }
        }
        return 'network_error';
    }
}


const heads = [
    {
        'accept-language': "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        'cache-control': "no-cache",
        'pragma': "no-cache",
        "sec-ch-ua": "\"Chromium\";v=\"120\", \"Not_A Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"macOS\"",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
    },
    {
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": "\"Google Chrome\";v=\"120\", \"Not_A Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
    }
];

var workingProxies = [];
var proxySessions = {}; // Maps proxy host to its cookie string
var proxyGuestSessions = {}; // Maps proxy host:port to its isolated guest cookie string
var proxySessionMeta = {}; // Maps proxy host:port to session/account metadata
var directCookie = '';  // Direct Moscow session cookie fallback
var activeRefreshes = 0; // Current number of parallel proxy cookie refreshes via Puppeteer
const USE_PROXIES = true; // Set to true to enable proxy rotation
const SHARE_ACCOUNTS_COOKIES = false; // Set to true to share account sessions across proxies
var accountSessions = {}; // Maps account username to its cookie string
const PROXY_SOURCE = process.env.PROXY_SOURCE || (process.env.NODE_ENV === 'test' ? 'file' : 'api'); // Options: 'api' (download from PROXY_API_URL on startup) or 'file' (read local proxies.txt)
const PROXY_API_URL = process.env.PROXY_API_URL || 'https://fineproxy.org/api/getproxy/?format=txt&type=socks_auth&login=mix427NUS9SZT&password=L4exSvPd';
const SCRAPE_PROFILE = normalizeScrapeProfile(process.env.SCRAPE_PROFILE || process.env.SPEED_PROFILE || 'fast');
const PROFILE_CONFIG = getScrapeProfileConfig(SCRAPE_PROFILE);
const AUTH_MODE = normalizeAuthMode(process.env.AUTH_MODE || 'logged'); // logged | guest | auto
let runtimeAuthMode = AUTH_MODE;
const MAX_ACTIVE_PER_ACCOUNT_SAFE = Math.max(1, parseInt(process.env.MAX_ACTIVE_PER_ACCOUNT_SAFE || String(PROFILE_CONFIG.activePerAccountSafe), 10));
const MAX_ACTIVE_PER_ACCOUNT_HARD = Math.max(MAX_ACTIVE_PER_ACCOUNT_SAFE, parseInt(process.env.MAX_ACTIVE_PER_ACCOUNT_HARD || String(PROFILE_CONFIG.activePerAccountHard), 10));
let currentActivePerAccountLimit = MAX_ACTIVE_PER_ACCOUNT_SAFE;
const STABLE_SUCCESS_WINDOW = Math.max(20, parseInt(process.env.STABLE_SUCCESS_WINDOW || '250', 10));
const STABLE_WINDOW_MS = Math.max(60000, parseInt(process.env.STABLE_WINDOW_MS || String(20 * 60 * 1000), 10));
const PROXY_COOLDOWN_MIN_MS = Math.max(0, parseInt(process.env.PROXY_COOLDOWN_MIN_MS || String(PROFILE_CONFIG.proxyCooldownMinMs), 10));
const PROXY_COOLDOWN_MAX_MS = Math.max(PROXY_COOLDOWN_MIN_MS, parseInt(process.env.PROXY_COOLDOWN_MAX_MS || String(PROFILE_CONFIG.proxyCooldownMaxMs), 10));
const ACCOUNT_REQUEST_INTERVAL_MIN_MS = Math.max(0, parseInt(process.env.ACCOUNT_REQUEST_INTERVAL_MIN_MS || String(PROFILE_CONFIG.accountIntervalMinMs), 10));
const ACCOUNT_REQUEST_INTERVAL_MAX_MS = Math.max(ACCOUNT_REQUEST_INTERVAL_MIN_MS, parseInt(process.env.ACCOUNT_REQUEST_INTERVAL_MAX_MS || String(PROFILE_CONFIG.accountIntervalMaxMs), 10));
const ACCOUNT_REQUEST_CONCURRENCY = Math.max(1, parseInt(process.env.ACCOUNT_REQUEST_CONCURRENCY || String(PROFILE_CONFIG.accountRequestConcurrency), 10));
const GUEST_REQUEST_CONCURRENCY = Math.max(1, parseInt(process.env.GUEST_REQUEST_CONCURRENCY || String(PROFILE_CONFIG.guestRequestConcurrency), 10));
const GUEST_REQUEST_CONCURRENCY_MAX = Math.max(GUEST_REQUEST_CONCURRENCY, parseInt(process.env.GUEST_REQUEST_CONCURRENCY_MAX || '2', 10));
const GUEST_REQUEST_INTERVAL_MIN_MS = Math.max(0, parseInt(process.env.GUEST_REQUEST_INTERVAL_MIN_MS || String(PROFILE_CONFIG.guestIntervalMinMs), 10));
const GUEST_REQUEST_INTERVAL_MAX_MS = Math.max(GUEST_REQUEST_INTERVAL_MIN_MS, parseInt(process.env.GUEST_REQUEST_INTERVAL_MAX_MS || String(PROFILE_CONFIG.guestIntervalMaxMs), 10));
const DIRECT_FALLBACK_IN_PROXY_MODE = process.env.DIRECT_FALLBACK_IN_PROXY_MODE === '1';
const REFILL_BATCH_SIZE = Math.max(1, parseInt(process.env.REFILL_BATCH_SIZE || '2', 10));
const GUEST_INITIAL_ACTIVE_PROXIES = Math.max(1, parseInt(process.env.GUEST_INITIAL_ACTIVE_PROXIES || '8', 10));
const GUEST_MAX_ACTIVE_PROXIES = Math.max(GUEST_INITIAL_ACTIVE_PROXIES, parseInt(process.env.GUEST_MAX_ACTIVE_PROXIES || '16', 10));
const GUEST_STABLE_SUCCESS_WINDOW = Math.max(1, parseInt(process.env.GUEST_STABLE_SUCCESS_WINDOW || '50', 10));
const RATE_LIMIT_REFILL_PAUSE_MS = Math.max(0, parseInt(process.env.RATE_LIMIT_REFILL_PAUSE_MS || String(5 * 60 * 1000), 10));
const GUEST_RATE_LIMIT_REFILL_PAUSE_MS = Math.max(0, parseInt(process.env.GUEST_RATE_LIMIT_REFILL_PAUSE_MS || String(60 * 1000), 10));
const PERSISTENT_RATE_LIMIT_TTL_MS = Math.max(60000, parseInt(process.env.PERSISTENT_RATE_LIMIT_TTL_MS || String(30 * 60 * 1000), 10));
const GLOBAL_RATE_LIMIT_THRESHOLD = Math.max(2, parseInt(process.env.GLOBAL_RATE_LIMIT_THRESHOLD || '3', 10));
const GLOBAL_RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS || '30000', 10));
const GLOBAL_RATE_LIMIT_PAUSES_MS = String(process.env.GLOBAL_RATE_LIMIT_PAUSES_MS || '120000,300000,900000,1800000')
    .split(',')
    .map(value => Math.max(1000, parseInt(value, 10)))
    .filter(Number.isFinite);
const RATE_LIMIT_PACING_PENALTY_MS = Math.max(0, parseInt(process.env.RATE_LIMIT_PACING_PENALTY_MS || String(10 * 60 * 1000), 10));
const RATE_LIMIT_PACING_MULTIPLIER = Math.max(1, Number(process.env.RATE_LIMIT_PACING_MULTIPLIER || '1.35'));
const VALIDATE_CACHED_SESSIONS = process.env.VALIDATE_CACHED_SESSIONS === undefined
    ? process.env.NODE_ENV !== 'test'
    : process.env.VALIDATE_CACHED_SESSIONS === '1';
const PROXY_AUTH_DELAY_MS = Math.max(0, parseInt(process.env.PROXY_AUTH_DELAY_MS || '3000', 10));

let isExiting = false;
let poolSelectionCursor = 0;
let currentGuestRequestConcurrency = GUEST_REQUEST_CONCURRENCY;
let currentGuestActiveLimit = GUEST_INITIAL_ACTIVE_PROXIES;
let guestStableSuccesses = 0;
let globalRateLimitStage = 0;
let globalRateLimitOpenUntil = 0;
let halfOpenProbeInFlight = false;
const rateLimitEvents = [];

// Register exit signal listeners to cancel background warming immediately
process.on('SIGINT', () => { isExiting = true; });
process.on('SIGTERM', () => { isExiting = true; });

const badProxies = new Map();
const softBlocks = new Map();
const busyProxies = new Set();
const pendingUnbans = new Set();
const reserveProxies = []; // Proxies available but not active — prevents session displacement
const MAX_ACTIVE_PER_ACCOUNT = MAX_ACTIVE_PER_ACCOUNT_SAFE; // Backward-compatible export value
let refillInProgress = false;
let lastUnbanScanTime = 0;
const UNBAN_SCAN_INTERVAL = 30000; // Minimum 30 seconds between unban scans
const proxyNextAvailableAt = new Map();
const accountRequestQueues = new Map();
const accountRequestNextAvailableAt = new Map();
const stabilityState = {
    successesSinceInstability: 0,
    lastInstabilityAt: Date.now()
};
let refillPausedUntil = 0;
let pacingPenaltyUntil = 0;

// Direct Connection cooldown — shared across all workers to prevent parallel 60s waits
let directCooldownUntil = 0;

function isDirectOnCooldown() {
    return Date.now() < directCooldownUntil;
}

function setDirectCooldown(durationMs) {
    const until = Date.now() + durationMs;
    if (until > directCooldownUntil) {
        directCooldownUntil = until;
    }
}

function getDirectCooldownRemaining() {
    return Math.max(0, directCooldownUntil - Date.now());
}

let proxyPool = [];

function findPoolProxy(proxy) {
    if (!proxy) return null;
    const key = getProxyKey(proxy);
    return proxyPool.find(p => getProxyKey(p) === key);
}

function syncLegacyArrays() {
    workingProxies = [];
    reserveProxies.length = 0;
    badProxies.clear();
    busyProxies.clear();
    
    for (const p of proxyPool) {
        const key = getProxyKey(p);
        if (p.state === 'reserve') {
            reserveProxies.push(p);
        } else if (p.state === 'quarantined') {
            badProxies.set(key, p.quarantineUntil || Date.now());
        } else {
            workingProxies.push(p);
            if (p.state === 'leased') {
                busyProxies.add(key);
            }
        }
    }
}

function updatePoolStates(now = Date.now()) {
    for (const p of proxyPool) {
        if (p.state === 'cooldown' && now >= p.cooldownEndAt) {
            p.state = 'ready';
        } else if (p.state === 'quarantined' && now >= p.quarantineUntil) {
            p.state = 'reserve';
            console.log(`[Proxy Pool] Quarantined proxy ${getProxyKey(p)} quarantine expired. Moved to reserve.`);
        }
    }
}

function releaseProxy(proxy) {
    if (!proxy) return;
    const p = findPoolProxy(proxy);
    if (p && p.state === 'leased') {
        releaseProxyLease(p, 'success');
    }
}

function getAvailableProxy(now = Date.now()) {
    updatePoolStates(now);
    const candidates = proxyPool.filter(p => p.state === 'ready');
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => (left.lastUsedAt || 0) - (right.lastUsedAt || 0));
    return candidates[0];
}

async function acquireProxyLease(options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 120000));
    const startedAt = Date.now();
    while (!isExiting) {
        await runUnbanScan();
        await maybeTriggerRefill();
        
        const proxy = getAvailableProxy();
        if (proxy) {
            proxy.state = 'leased';
            proxy.lastUsedAt = Date.now();
            updateProxyMeta(proxy, { status: 'leased', lastUsedAt: proxy.lastUsedAt });
            syncLegacyArrays();
            
            const ua = getFingerprint(proxy);
            if (isGuestMode()) {
                ua.Cookie = getProxyGuestCookie(proxy);
            } else {
                ua.Cookie = getProxyCookie(proxy);
            }
            let released = false;
            return {
                proxy,
                ua,
                release(outcome = null) {
                    if (released) return;
                    released = true;
                    if (outcome) {
                        releaseProxyLease(proxy, outcome);
                    } else {
                        releaseProxyLease(proxy, 'success');
                    }
                }
            };
        }
        if (Date.now() - startedAt >= timeoutMs) {
            const error = new Error(`Timed out waiting ${timeoutMs}ms for an available proxy lease`);
            error.code = 'PROXY_LEASE_TIMEOUT';
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    const error = new Error('Proxy manager is shutting down');
    error.code = 'PROXY_MANAGER_EXITING';
    throw error;
}

function releaseProxyLease(proxy, outcome) {
    const p = findPoolProxy(proxy);
    if (!p) return;
    
    p.lastUsedAt = Date.now();
    p.networkFailureCount = p.networkFailureCount || 0;
    
    if (outcome === 'success') {
        const cooldownMs = PROXY_COOLDOWN_MIN_MS + Math.random() * (PROXY_COOLDOWN_MAX_MS - PROXY_COOLDOWN_MIN_MS);
        p.state = 'cooldown';
        p.cooldownEndAt = Date.now() + cooldownMs;
        p.networkFailureCount = 0;
        updateProxyMeta(p, {
            status: 'ready',
            lastSuccessAt: new Date().toISOString(),
            networkFailureCount: 0,
            cooldownEndAt: p.cooldownEndAt
        });
    } else if (outcome === 'test_ready') {
        p.state = 'ready';
        p.cooldownEndAt = 0;
        p.networkFailureCount = 0;
        updateProxyMeta(p, {
            status: 'active',
            cooldownEndAt: 0,
            networkFailureCount: 0
        });
    } else if (outcome === 'rate_limited' || outcome === 'forbidden') {
        p.state = 'quarantined';
        p.quarantineUntil = Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS;
        updateProxyMeta(p, {
            status: 'quarantine',
            last429At: new Date().toISOString(),
            quarantineUntil: new Date(p.quarantineUntil).toISOString()
        });
        noteProxyInstability(p, outcome);
    } else if (outcome === 'auth_issue' || outcome === 'expired') {
        p.state = 'invalid';
        setProxyCookie(p, null);
        const patch = { status: 'invalid' };
        if (outcome === 'expired') {
            patch.lastUserType = 'guest';
        }
        updateProxyMeta(p, patch);
        noteProxyInstability(p, outcome);
    } else if (outcome === 'network') {
        p.networkFailureCount++;
        if (p.networkFailureCount >= 3) {
            p.state = 'quarantined';
            p.quarantineUntil = Date.now() + 5 * 60 * 1000; // Shorter quarantine for network issues
            updateProxyMeta(p, {
                status: 'quarantine',
                quarantineUntil: new Date(p.quarantineUntil).toISOString(),
                networkFailureCount: p.networkFailureCount
            });
        } else {
            p.state = 'cooldown';
            p.cooldownEndAt = Date.now() + 5000; // Short cooldown retry
            updateProxyMeta(p, {
                status: 'ready',
                cooldownEndAt: p.cooldownEndAt,
                networkFailureCount: p.networkFailureCount
            });
        }
    }
    syncLegacyArrays();
    saveProxySessions();
}

const BAD_PROXY_TTL = 10 * 60 * 1000; // 10 minutes

let consecutiveLaunchErrors = 0;
let circuitBreakerLockedUntil = 0;

function checkLaunchAllowed() {
    const now = Date.now();
    if (now < circuitBreakerLockedUntil) {
        throw new Error(`Puppeteer Circuit Breaker is active! Browser launches locked for another ${Math.round((circuitBreakerLockedUntil - now) / 1000)}s.`);
    }
}

function reportLaunchSuccess() {
    consecutiveLaunchErrors = 0;
    circuitBreakerLockedUntil = 0;
}

function reportLaunchError() {
    consecutiveLaunchErrors++;
    if (consecutiveLaunchErrors >= 3) {
        const lockDuration = 45000; // 45 seconds lock
        circuitBreakerLockedUntil = Date.now() + lockDuration;
        console.log(`[Circuit Breaker] CRITICAL: 3 consecutive browser launch errors. Locking all new launches for 45s.`);
    }
}

function markProxyBad(proxy, reason = 'bad') {
    if (!proxy) return;
    const p = findPoolProxy(proxy);
    if (!p) return;
    
    if (reason === 'guest' || reason === 'auth_issue' || reason === 'challenge') {
        releaseProxyLease(p, 'auth_issue');
    } else if (reason === 'rate_limited' || reason === '429' || reason === '403') {
        releaseProxyLease(p, 'rate_limited');
    } else {
        if (reason === 'network') {
            p.networkFailureCount = 3;
            releaseProxyLease(p, 'network');
        } else {
            p.state = 'quarantined';
            p.quarantineUntil = Date.now() + 5 * 60 * 1000;
            updateProxyMeta(p, {
                status: 'quarantine',
                quarantineUntil: new Date(p.quarantineUntil).toISOString()
            });
            syncLegacyArrays();
        }
    }
    
    // Close browser session if any
    try {
        const pupp = require('./pupp.js');
        pupp.closeSession(getProxyKey(p));
    } catch (err) {
        // ignore
    }
}

async function unbanAndRefresh(proxy) {
    const p = findPoolProxy(proxy);
    if (p) {
        p.state = 'reserve';
        p.quarantineUntil = 0;
        updateProxyMeta(p, { status: 'reserve', quarantineUntil: null });
        syncLegacyArrays();
        console.log(`[Proxy Manager] Proxy ${getProxyKey(p)} unbanned → reserve pool.`);
    }
}

function handleSoftBlock(proxy) {
    if (!proxy) return;
    const key = `${proxy.host}:${proxy.port}`;
    const count = (softBlocks.get(key) || 0) + 1;
    softBlocks.set(key, count);
    console.log(`[Proxy Manager] Soft block warning for ${key} (${count}/3)`);
    if (count >= 3) {
        console.log(`[Proxy Manager] Proxy ${key} reached 3 consecutive soft-blocks. Banning for 5 minutes.`);
        softBlocks.delete(key);
        markProxyBad(proxy, 'soft_block');
    }
}

function resetSoftBlock(proxy) {
    if (!proxy) return;
    softBlocks.set(`${proxy.host}:${proxy.port}`, 0);
}

function parseCookies(setCookieHeader) {
    if (!setCookieHeader) return '';
    return setCookieHeader.map(c => c.split(';')[0]).join('; ');
}

function mergeCookies(oldCookieStr, newSetCookieHeaders) {
    const cookieMap = new Map();
    if (oldCookieStr) {
        oldCookieStr.split(';').forEach(c => {
            const parts = c.trim().split('=');
            if (parts[0]) {
                cookieMap.set(parts[0], parts.slice(1).join('='));
            }
        });
    }
    if (newSetCookieHeaders) {
        newSetCookieHeaders.forEach(c => {
            const parts = c.split(';')[0].trim().split('=');
            if (parts[0]) {
                cookieMap.set(parts[0], parts.slice(1).join('='));
            }
        });
    }
    return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function setCityInCookieString(cookieStr, cityId) {
    if (!cookieStr) {
        return `guest_city_id=${cityId}`;
    }
    const parts = cookieStr.split(';').map(p => p.trim()).filter(Boolean);
    let found = false;
    const newParts = parts.map(p => {
        const eqIdx = p.indexOf('=');
        if (eqIdx !== -1) {
            const key = p.substring(0, eqIdx).trim();
            if (key === 'guest_city_id') {
                found = true;
                return `guest_city_id=${cityId}`;
            }
        }
        return p;
    });
    if (!found) {
        newParts.push(`guest_city_id=${cityId}`);
    }
    return newParts.join('; ');
}

async function renewDirectSession() {
    if (directCookie) {
        console.log(`[Direct Connection] Testing cached direct session...`);
        const status = await testProxySession({ protocol: 'direct' }, directCookie);
        if (status === 'valid') {
            console.log(`[Direct Connection] \x1b[32mSUCCESS\x1b[0m: Cached direct session is valid.`);
            return true;
        }
        console.log(`[Direct Connection] Cached direct session is expired or invalid.`);
    }

    try {
        console.log(`[Direct Connection] Establishing direct logged-in Moscow session via Puppeteer...`);
        const pupp = require('./pupp.js');
        const cookies = await pupp.getCookies(null, true, null, 0); // Direct login
        if (cookies && cookies.includes('sessionId=')) {
            const status = await testProxySession({ protocol: 'direct' }, cookies);
            if (status !== 'valid') {
                console.log(`[Direct Connection] New direct session validation returned ${status}.`);
                return false;
            }
            directCookie = cookies;
            saveProxySessions();
            console.log(`[Direct Connection] \x1b[32mSUCCESS\x1b[0m: Direct logged-in Moscow session established.`);
            return true;
        }
        return false;
    } catch (err) {
        console.log(`[Direct Connection] \x1b[31mFAILED\x1b[0m to establish logged-in session: ${err.message}`);
        return false;
    }
}

async function downloadProxies() {
    if (PROXY_SOURCE !== 'api' || !PROXY_API_URL) return;
    try {
        console.log(`[Proxy Manager] Downloading latest proxies from API...`);
        const res = await axios.get(PROXY_API_URL, { timeout: 10000 });
        if (res.data && typeof res.data === 'string') {
            const proxiesFile = getProxiesFilePath();
            fs.writeFileSync(proxiesFile, res.data.trim(), 'utf-8');
            console.log(`[Proxy Manager] Successfully downloaded and saved proxies to ${proxiesFile}.`);
        }
    } catch (err) {
        console.log(`[Proxy Manager] \x1b[33mWARNING\x1b[0m: Failed to download proxies from API: ${err.message}. Using cached proxies.txt.`);
    }
}

async function initprox() {
    workingProxies = [];
    reserveProxies.length = 0;
    busyProxies.clear();
    for (const k in proxySessions) delete proxySessions[k];
    for (const k in proxyGuestSessions) delete proxyGuestSessions[k];
    for (const k in proxySessionMeta) delete proxySessionMeta[k];
    directCookie = '';
    
    // Reset global state
    globalRateLimitStage = 0;
    globalRateLimitOpenUntil = 0;
    halfOpenProbeInFlight = false;
    rateLimitEvents.length = 0;
    refillPausedUntil = 0;
    pacingPenaltyUntil = 0;
    guestStableSuccesses = 0;
    currentGuestRequestConcurrency = GUEST_REQUEST_CONCURRENCY;
    currentGuestActiveLimit = GUEST_INITIAL_ACTIVE_PROXIES;
    
    // Load cached sessions
    loadProxySessions();
    
    if (!USE_PROXIES) {
        console.log(`\n==================================================`);
        console.log(`Proxy Manager: Running in DIRECT CONNECTION mode (Proxies disabled)`);
        console.log(`==================================================`);
        await renewDirectSession();
        return;
    }
    
    // Download latest proxies from API only if PROXY_SOURCE is set to 'api'
    if (PROXY_SOURCE === 'api') {
        await downloadProxies();
    }
    
    const allProxies = getProxies();
    const total = allProxies.length;
    const accounts = getAllAccounts();
    validateStartupConfig(allProxies, accounts);
    assignProxyAccountIndexes(allProxies, Math.max(accounts.length, 1));
    
    // Initialize proxyPool with states, honoring quarantineUntil
    const now = Date.now();
    proxyPool = allProxies.map(p => {
        const key = getProxyKey(p);
        const meta = proxySessionMeta[key] || {};
        const qUntil = meta.quarantineUntil ? new Date(meta.quarantineUntil).getTime() : 0;
        
        let state = 'reserve';
        let quarantineUntil = 0;
        if (Number.isFinite(qUntil) && qUntil > now) {
            state = 'quarantined';
            quarantineUntil = qUntil;
            console.log(`[Proxy Pool] Restoring quarantined state on startup for ${key} until ${meta.quarantineUntil}`);
        }
        
        return {
            host: p.host,
            port: p.port,
            auth: p.auth,
            protocol: p.protocol || 'socks5',
            accountIndex: getProxyAccountIndex(p, Math.max(accounts.length, 1)),
            state,
            cooldownEndAt: 0,
            quarantineUntil,
            networkFailureCount: meta.networkFailureCount || 0,
            lastUsedAt: meta.lastUsedAt || 0
        };
    });
    
    console.log(`\n==================================================`);
    console.log(`Loaded ${total} proxies. Restored quarantined ones. Starting verification...`);
    console.log(`==================================================`);

    if (canUseDirectFallback() && isLoggedMode()) {
        await renewDirectSession();
    } else {
        console.log(`[Direct Connection] Skipped in proxy mode. Direct fallback is ${DIRECT_FALLBACK_IN_PROXY_MODE ? 'enabled' : 'disabled'}; auth mode=${runtimeAuthMode}.`);
    }

    if (SHARE_ACCOUNTS_COOKIES) {
        console.log(`[Proxy Manager] Account cookie sharing enabled. Authenticating ${accounts.length} accounts...`);
        
        for (let aIdx = 0; aIdx < accounts.length; aIdx++) {
            const acc = accounts[aIdx];
            let cookies = accountSessions[acc.username];
            let status = null;
            if (cookies) {
                console.log(`[Proxy Manager] [Account ${aIdx + 1}/${accounts.length}] Testing cached session for account ${acc.username}...`);
                status = await testProxySession({ protocol: 'direct' }, cookies);
            }
            
            if (status === 'valid') {
                console.log(`[Proxy Manager] [Account ${aIdx + 1}/${accounts.length}] \x1b[32mCACHED SESSION VALID\x1b[0m for account ${acc.username}`);
            } else {
                console.log(`[Proxy Manager] [Account ${aIdx + 1}/${accounts.length}] Establishing new session via Puppeteer for account ${acc.username}...`);
                const pupp = require('./pupp.js');
                try {
                    const loggedInCookies = await pupp.getCookies(null, true, acc, aIdx);
                    if (loggedInCookies) {
                        accountSessions[acc.username] = loggedInCookies;
                        saveProxySessions();
                        console.log(`[Proxy Manager] [Account ${aIdx + 1}/${accounts.length}] \x1b[32mAUTHENTICATION SUCCESSFUL\x1b[0m for account ${acc.username}`);
                    } else {
                        throw new Error("Puppeteer returned empty cookies");
                    }
                } catch (err) {
                    console.log(`[Proxy Manager] [Account ${aIdx + 1}/${accounts.length}] \x1b[31mAUTHENTICATION FAILED\x1b[0m for account ${acc.username}: ${err.message}`);
                }
            }
        }
        
        // Distribute cookies to all proxies
        for (let index = 0; index < allProxies.length; index++) {
            const proxy = allProxies[index];
            if (!proxy.host || !proxy.port) continue;
            proxy.protocol = 'socks5';
            
            const indexAccount = getProxyAccountIndex(proxy, accounts.length);
            const assignedAccount = accounts[indexAccount];
            const accountCookie = accountSessions[assignedAccount.username];
            
            const poolProxy = findPoolProxy(proxy);
            if (poolProxy && poolProxy.state !== 'quarantined' && accountCookie) {
                setProxyCookie(proxy, accountCookie);
                poolProxy.state = 'ready';
            }
        }
    } else {
        const accountCount = getAccountCount();
        const selection = selectInitialProxyPools(
            allProxies,
            proxySessions,
            accountCount,
            currentActivePerAccountLimit,
            isGuestMode() ? 'guest' : 'logged'
        );

        console.log(`[Proxy Manager] Auth mode: ${runtimeAuthMode}. Scrape profile=${SCRAPE_PROFILE}. Safe session limit: ${currentActivePerAccountLimit} per account × ${accountCount} account(s).`);
        console.log(`[Proxy Manager] Account request lanes=${ACCOUNT_REQUEST_CONCURRENCY}, proxy cooldown=${PROXY_COOLDOWN_MIN_MS}-${PROXY_COOLDOWN_MAX_MS}ms.`);
        console.log(`[Proxy Manager] Initial active targets: ${selection.active.length} cached/guest, ${selection.toAuthenticate.length} need login, ${selection.reserve.length} reserve.`);

        // Map selection to proxyPool states, without overwriting quarantined state
        for (const p of selection.active) {
            const poolProxy = findPoolProxy(p);
            if (poolProxy && poolProxy.state !== 'quarantined') {
                poolProxy.state = 'ready';
            }
        }
        for (const p of selection.toAuthenticate) {
            const poolProxy = findPoolProxy(p);
            if (poolProxy && poolProxy.state !== 'quarantined') {
                poolProxy.state = 'auth_pending';
            }
        }
        for (const p of selection.reserve) {
            const poolProxy = findPoolProxy(p);
            if (poolProxy && poolProxy.state !== 'quarantined') {
                poolProxy.state = 'reserve';
            }
        }
        
        syncLegacyArrays();

        const authQueue = [];
        for (const p of proxyPool.filter(item => item.state === 'ready')) {
            ensureProxyMeta(p);
            const key = getProxyKey(p);
            const cookieState = isGuestMode()
                ? (getProxyGuestCookie(p) ? 'guest-session' : 'guest-bootstrap')
                : (hasUsableLoggedCookie(p) ? 'cached-session' : 'missing-cookie');

            if (!isGuestMode() && VALIDATE_CACHED_SESSIONS && hasUsableLoggedCookie(p)) {
                console.log(`[Proxy Auth] Testing cached session ${key} account=${getProxyAccountIndex(p) + 1}...`);
                const status = await testProxySession(p, getProxyCookie(p));
                if (status === 'valid') {
                    console.log(`[Proxy Auth] \x1b[32mACTIVE\x1b[0m ${key} account=${getProxyAccountIndex(p) + 1} source=${cookieState}`);
                } else if (status === 'expired' || status === 'unauthorized' || status === 'error') {
                    console.log(`[Proxy Auth] Cached session ${key} is ${status}; scheduling controlled login.`);
                    setProxyCookie(p, null);
                    p.state = 'auth_pending';
                    authQueue.push(p);
                } else if (status === 'rate_limited' || status === 'forbidden' || status === 'block') {
                    console.log(`[Proxy Auth] Cached session ${key} validation returned ${status}; quarantining.`);
                    p.state = 'quarantined';
                    p.quarantineUntil = Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS;
                    updateProxyMeta(p, {
                        status: 'quarantine',
                        quarantineUntil: new Date(p.quarantineUntil).toISOString()
                    });
                } else {
                    console.log(`[Proxy Auth] Cached session ${key} validation returned ${status}; moving to reserve.`);
                    p.state = 'reserve';
                }
            } else {
                console.log(`[Proxy Auth] \x1b[32mACTIVE\x1b[0m ${key} account=${getProxyAccountIndex(p) + 1} source=${cookieState}`);
            }
        }

        for (const p of proxyPool.filter(item => item.state === 'auth_pending')) {
            authQueue.push(p);
        }

        syncLegacyArrays();

        if (authQueue.length > 0 && isLoggedMode()) {
            console.log(`[Proxy Manager] Authenticating ${authQueue.length} balanced proxies via controlled Puppeteer refill...`);

            for (let i = 0; i < authQueue.length; i++) {
                if (isExiting) {
                    console.log(`[Proxy Manager] Upfront proxy initialization aborted due to exit signal.`);
                    break;
                }

                const p = authQueue[i];
                const key = getProxyKey(p);
                try {
                    console.log(`[Proxy Manager] Authenticating ${key} (${i + 1}/${authQueue.length}) account=${getProxyAccountIndex(p) + 1}...`);
                    const activated = await activateOrRefreshProxy(p);
                    if (activated) {
                        console.log(`[Proxy Manager] \x1b[32mAUTHENTICATION SUCCESSFUL\x1b[0m for SOCKS5h ${key}`);
                    } else {
                        throw new Error("Puppeteer returned empty cookies");
                    }
                } catch (err) {
                    console.log(`[Proxy Manager] \x1b[31mAUTHENTICATION FAILED\x1b[0m for SOCKS5h ${key}: ${err.message}`);
                    p.state = 'reserve';
                }

                if (i + 1 < authQueue.length && !isExiting && PROXY_AUTH_DELAY_MS > 0) {
                    await new Promise(r => setTimeout(r, PROXY_AUTH_DELAY_MS));
                }
            }
        }
    }

    syncLegacyArrays();
    validateLoggedStartupReady();

    const activeCounts = getActiveCountsByAccount();
    console.log(`\n==================================================`);
    console.log(`Proxy validation and authentication finished.`);
    console.log(`Active proxies: \x1b[32m${workingProxies.length}\x1b[0m | Reserve: \x1b[33m${reserveProxies.length}\x1b[0m / ${total}`);
    console.log(`Active per account: ${JSON.stringify(activeCounts)}`);
    console.log(`==================================================\n`);

    if (workingProxies.length === 0 && !canUseDirectFallback()) {
        console.warn("\x1b[33mWARNING: No active proxies found and direct fallback is disabled. Requests will wait for refill.\x1b[0m");
    } else if (workingProxies.length === 0) {
        console.warn("\x1b[33mWARNING: No working proxies found! Scraper will run locally without proxies.\x1b[0m");
    }
}

// Background refill: activate proxies from reserve when active pool runs low
async function refillFromReserve() {
    if (refillInProgress || reserveProxies.length === 0) return;
    if (Date.now() < refillPausedUntil) return;
    refillInProgress = true;
    
    try {
        const accountCount = getAccountCount();
        const activeCounts = getActiveCountsByAccount();
        const activeLimit = getCurrentActivePerAccountLimit();
        const toActivate = [];

        if (isGuestMode()) {
            const activeCount = workingProxies.filter(p => !badProxies.has(getProxyKey(p))).length;
            const needed = Math.max(0, currentGuestActiveLimit - activeCount);
            let scanned = 0;
            while (toActivate.length < Math.min(REFILL_BATCH_SIZE, needed) && reserveProxies.length > 0 && scanned < reserveProxies.length) {
                const proxy = reserveProxies.shift();
                const poolProxy = findPoolProxy(proxy);
                if (!poolProxy || poolProxy.state === 'quarantined') {
                    reserveProxies.push(proxy);
                    scanned++;
                    continue;
                }
                toActivate.push(proxy);
            }
        } else {
            for (let accountIndex = 0; accountIndex < accountCount && toActivate.length < REFILL_BATCH_SIZE; accountIndex++) {
                const count = activeCounts[accountIndex] || 0;
                if (count >= activeLimit) continue;
                const reserveIndex = reserveProxies.findIndex(p => {
                    const poolProxy = findPoolProxy(p);
                    return poolProxy && poolProxy.state === 'reserve' && getProxyAccountIndex(p, accountCount) === accountIndex;
                });
                if (reserveIndex === -1) continue;
                const [proxy] = reserveProxies.splice(reserveIndex, 1);
                toActivate.push(proxy);
                activeCounts[accountIndex] = count + 1;
            }
        }

        if (toActivate.length === 0) return;

        console.log(`[Proxy Manager] Active pool refill: activating ${toActivate.length} from reserve (${reserveProxies.length} still reserved), limit=${activeLimit}/account.`);
        
        for (const proxy of toActivate) {
            const key = getProxyKey(proxy);
            proxy.protocol = 'socks5';

            if (isGuestMode()) {
                const p = findPoolProxy(proxy);
                if (p) p.state = 'ready';
                syncLegacyArrays();
                console.log(`[Proxy Manager] \x1b[32mActivated\x1b[0m ${key} from reserve in guest mode.`);
                continue;
            }
            
            try {
                const activated = await activateOrRefreshProxy(proxy);
                if (activated) {
                    console.log(`[Proxy Manager] \x1b[32mActivated\x1b[0m ${key} from reserve.`);
                } else {
                    const p = findPoolProxy(proxy);
                    if (p && p.state !== 'quarantined') {
                        p.state = 'reserve';
                    }
                    syncLegacyArrays();
                }
            } catch (err) {
                console.log(`[Proxy Manager] Failed to activate ${key}: ${err.message}`);
                const p = findPoolProxy(proxy);
                if (p && p.state !== 'quarantined') {
                    p.state = 'reserve';
                }
                syncLegacyArrays();
            }
        }
    } finally {
        refillInProgress = false;
    }
}

async function activateOrRefreshProxy(proxy) {
    const cachedCookies = getProxyCookie(proxy);
    if (cachedCookies && cachedCookies.includes('sessionId=')) {
        console.log(`[Proxy Pool] Testing cached cookies for ${getProxyKey(proxy)} before auth...`);
        const status = await testProxySession(proxy, cachedCookies);
        if (status === 'valid') {
            console.log(`[Proxy Pool] Cached cookies valid for ${getProxyKey(proxy)}. Skipping Puppeteer.`);
            const p = findPoolProxy(proxy);
            if (p) p.state = 'ready';
            updateProxyMeta(proxy, { status: 'active' });
            syncLegacyArrays();
            return true;
        } else if (status === 'rate_limited' || status === 'forbidden' || status === 'block') {
            console.log(`[Proxy Pool] Proxy ${getProxyKey(proxy)} is rate limited or blocked during validation. Quarantining.`);
            const p = findPoolProxy(proxy);
            if (p) {
                p.state = 'quarantined';
                p.quarantineUntil = Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS;
            }
            updateProxyMeta(proxy, {
                status: 'quarantine',
                quarantineUntil: new Date(Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS).toISOString()
            });
            syncLegacyArrays();
            return false;
        } else {
            console.log(`[Proxy Pool] Cached cookies invalid (${status}) for ${getProxyKey(proxy)}.`);
        }
    }
    
    const p = findPoolProxy(proxy);
    if (p) p.state = 'auth_pending';
    syncLegacyArrays();
    
    try {
        const pupp = require('./pupp.js');
        const accountIndex = getProxyAccountIndex(proxy);
        const newCookies = await pupp.getCookies(proxy, false, null, accountIndex);
        if (newCookies && newCookies.includes('sessionId=')) {
            const status = await testProxySession(proxy, newCookies);
            if (status !== 'valid') {
                console.log(`[Proxy Pool] New cookies for ${getProxyKey(proxy)} failed validation (${status}).`);
                const poolProxy = findPoolProxy(proxy);
                if (status === 'rate_limited' || status === 'forbidden' || status === 'block') {
                    if (poolProxy) {
                        poolProxy.state = 'quarantined';
                        poolProxy.quarantineUntil = Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS;
                    }
                    updateProxyMeta(proxy, {
                        status: 'quarantine',
                        quarantineUntil: new Date(Date.now() + PERSISTENT_RATE_LIMIT_TTL_MS).toISOString()
                    });
                } else {
                    if (poolProxy) poolProxy.state = 'invalid';
                    updateProxyMeta(proxy, { status: 'invalid', lastUserType: status === 'expired' ? 'guest' : null });
                }
                syncLegacyArrays();
                return false;
            }
            setProxyCookie(proxy, newCookies);
            const poolProxy = findPoolProxy(proxy);
            if (poolProxy) poolProxy.state = 'ready';
            updateProxyMeta(proxy, { status: 'active' });
            syncLegacyArrays();
            return true;
        } else {
            console.log(`[Proxy Pool] Puppeteer returned no sessionId for ${getProxyKey(proxy)}.`);
            const poolProxy = findPoolProxy(proxy);
            if (poolProxy) poolProxy.state = 'invalid';
            updateProxyMeta(proxy, { status: 'invalid' });
            syncLegacyArrays();
            return false;
        }
    } catch (err) {
        console.log(`[Proxy Pool] Puppeteer login failed for ${getProxyKey(proxy)}: ${err.message}`);
        const poolProxy = findPoolProxy(proxy);
        if (poolProxy) poolProxy.state = 'invalid';
        updateProxyMeta(proxy, { status: 'invalid' });
        syncLegacyArrays();
        return false;
    }
}

async function maybeTriggerRefill() {
    const accountCount = getAccountCount();
    const activeLimit = isGuestMode() ? currentGuestActiveLimit : getCurrentActivePerAccountLimit() * accountCount;
    const activeCount = proxyPool.filter(p => p.state === 'ready' || p.state === 'leased' || p.state === 'cooldown').length;
    if (activeCount < Math.max(1, Math.floor(activeLimit * 0.7)) && reserveProxies.length > 0 && !refillInProgress) {
        await refillFromReserve();
    }
}

async function runUnbanScan() {
    const now = Date.now();
    if (now - lastUnbanScanTime < UNBAN_SCAN_INTERVAL) return;
    lastUnbanScanTime = now;
    
    const quarantined = proxyPool.filter(p => {
        if (p.state !== 'quarantined') return false;
        const key = getProxyKey(p);
        const badUntil = badProxies.get(key) || p.quarantineUntil || 0;
        return now >= badUntil;
    });
    if (quarantined.length === 0) return;
    
    console.log(`[Proxy Pool] Found ${quarantined.length} expired quarantined proxies. Processing unbans...`);
    const toProcess = quarantined.slice(0, 5);
    for (const p of toProcess) {
        p.state = 'reserve';
        p.quarantineUntil = 0;
        updateProxyMeta(p, { status: 'reserve', quarantineUntil: null });
        console.log(`[Proxy Pool] Quarantined proxy ${getProxyKey(p)} quarantine expired -> reserve.`);
    }
    syncLegacyArrays();
}

function getUa() {
    const now = Date.now();
    
    const quarantined = proxyPool.filter(p => {
        if (p.state !== 'quarantined') return false;
        const key = getProxyKey(p);
        const badUntil = badProxies.get(key) || p.quarantineUntil || 0;
        return now >= badUntil;
    });
    for (const p of quarantined.slice(0, 5)) {
        p.state = 'reserve';
        p.quarantineUntil = 0;
        updateProxyMeta(p, { status: 'reserve', quarantineUntil: null });
    }
    
    const accountCount = getAccountCount();
    const activeLimit = isGuestMode() ? currentGuestActiveLimit : getCurrentActivePerAccountLimit() * accountCount;
    const activeCount = proxyPool.filter(p => p.state === 'ready' || p.state === 'leased' || p.state === 'cooldown').length;
    if (activeCount < Math.max(1, Math.floor(activeLimit * 0.7)) && reserveProxies.length > 0 && !refillInProgress) {
        refillFromReserve().catch(() => {});
    }

    updatePoolStates(now);
    syncLegacyArrays();

    const chosen = getAvailableProxy(now);
    const ua = {};
    if (chosen) {
        chosen.state = 'leased';
        chosen.lastUsedAt = now;
        updateProxyMeta(chosen, { status: 'leased', lastUsedAt: now });
        syncLegacyArrays();
        
        Object.assign(ua, getFingerprint(chosen));
        ua.Cookie = isGuestMode() ? getProxyGuestCookie(chosen) : getProxyCookie(chosen);
        return { 'ua': ua, 'rp': chosen };
    } else if (canUseDirectFallback()) {
        ua['Cookie'] = directCookie;
        return { 'ua': ua, 'rp': null };
    } else {
        return { 'ua': ua, 'rp': null, 'unavailable': true };
    }
}

async function setSessionCity(proxy, cityId) {
    let currentCookies = '';
    if (proxy) {
        currentCookies = getProxyCookie(proxy) || '';
    } else {
        currentCookies = directCookie || '';
    }
    
    const newCookies = setCityInCookieString(currentCookies, cityId);
    
    if (proxy) {
        setProxyCookie(proxy, newCookies);
    } else {
        directCookie = newCookies;
    }
    return true;
}

function getProxySessions() {
    return proxySessions;
}

function getDirectCookie() {
    return directCookie;
}

function updateDirectCookie(cookies) {
    directCookie = cookies;
}

function getWorkingProxiesCount() {
    return workingProxies.filter(p => !badProxies.has(getProxyKey(p))).length;
}

function getProxyPoolSnapshot() {
    const now = Date.now();
    const allMeta = Object.values(proxySessionMeta);
    return {
        authMode: runtimeAuthMode,
        scrapeProfile: SCRAPE_PROFILE,
        timing: getTimingConfig(),
        activePerAccountLimit: getCurrentActivePerAccountLimit(),
        activeCountsByAccount: getActiveCountsByAccount(),
        active: workingProxies.filter(p => !badProxies.has(getProxyKey(p))).length,
        reserve: reserveProxies.length,
        bad: badProxies.size,
        busy: busyProxies.size,
        leased: busyProxies.size,
        persistentQuarantine: allMeta.filter(meta => meta && meta.quarantineUntil && new Date(meta.quarantineUntil).getTime() > now).length,
        loggedCookieSessions: Object.values(proxySessions).filter(cookie => typeof cookie === 'string' && cookie.includes('sessionId=')).length,
        guestCookieSessions: Object.values(proxyGuestSessions).filter(Boolean).length,
        guestRequestLanes: currentGuestRequestConcurrency,
        guestStableSuccesses,
        guestCurrentActiveLimit: currentGuestActiveLimit,
        guestMaxActiveProxies: GUEST_MAX_ACTIVE_PROXIES,
        validateCachedSessions: VALIDATE_CACHED_SESSIONS,
        directFallbackEnabled: canUseDirectFallback(),
        directCooldownRemainingMs: getDirectCooldownRemaining(),
        refillPausedRemainingMs: Math.max(0, refillPausedUntil - now),
        pacingPenaltyRemainingMs: Math.max(0, pacingPenaltyUntil - now),
        pacingPenaltyMultiplier: RATE_LIMIT_PACING_MULTIPLIER,
        globalRateLimit: {
            stage: globalRateLimitStage,
            openRemainingMs: Math.max(0, globalRateLimitOpenUntil - now),
            halfOpenProbeInFlight
        },
        stability: {
            successesSinceInstability: stabilityState.successesSinceInstability,
            secondsSinceInstability: Math.round((now - stabilityState.lastInstabilityAt) / 1000)
        }
    };
}

process.on('exit', () => {
    if (process.env.DISABLE_SESSION_EXIT_FLUSH !== '1') {
        flushProxySessions();
    }
});

module.exports = { 
    initprox, 
    getUa, 
    USE_PROXIES, 
    renewDirectSession,
    findPoolProxy,
    markProxyBad,
    handleSoftBlock,
    resetSoftBlock,
    checkLaunchAllowed,
    reportLaunchSuccess,
    reportLaunchError,
    badProxies,
    setSessionCity,
    getProxySessions,
    getDirectCookie,
    updateDirectCookie,
    mergeCookies,
    heads,
    releaseProxy,
    getWorkingProxiesCount,
    saveProxySessions,
    flushProxySessions,
    clearAccountSessionByCookie,
    isDirectOnCooldown,
    setDirectCooldown,
    getDirectCooldownRemaining,
    reserveProxies,
    proxySessionMeta,
    getProxyKey,
    getProxyAccountIndex,
    getAccountCount,
    getAuthMode,
    setRuntimeAuthMode,
    isGuestMode,
    isLoggedMode,
    getProxyCookie,
    setProxyCookie,
    getProxyGuestCookie,
    setProxyGuestCookie,
    getFingerprint,
    recordProxyResult,
    acquireRequestSlot,
    acquireProxyLease,
    canUseDirectFallback,
    getActiveCountsByAccount,
    getProxyPoolSnapshot,
    getTimingConfig,
    getParserConcurrency,
    getCurrentActivePerAccountLimit,
    selectInitialProxyPools,
    assignProxyAccountIndexes,
    getAllAccounts,
    testProxySession,
    validateStartupConfig,
    MAX_ACTIVE_PER_ACCOUNT_SAFE,
    MAX_ACTIVE_PER_ACCOUNT_HARD,
    RATE_LIMIT_REFILL_PAUSE_MS,
    ACCOUNT_REQUEST_CONCURRENCY,
    ACCOUNT_REQUEST_INTERVAL_MIN_MS,
    ACCOUNT_REQUEST_INTERVAL_MAX_MS,
    GUEST_REQUEST_CONCURRENCY,
    GUEST_REQUEST_CONCURRENCY_MAX,
    GUEST_REQUEST_INTERVAL_MIN_MS,
    GUEST_REQUEST_INTERVAL_MAX_MS,
    GUEST_MAX_ACTIVE_PROXIES,
    GUEST_INITIAL_ACTIVE_PROXIES,
    RATE_LIMIT_PACING_MULTIPLIER,
    PERSISTENT_RATE_LIMIT_TTL_MS,
    getRecentRateLimitRemainingMs,
    isRecentlyRateLimited,
    SCRAPE_PROFILE
};
