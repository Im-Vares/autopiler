const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getUa, heads } = require('./prox.js');
const httpProxyAgent = require('http-proxy-agent');
const httpsProxyAgent = require('https-proxy-agent');
let SocksProxyAgent = null;
try {
  SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
} catch (err) {
  // socks-proxy-agent not installed
}



const BRAND_ALIASES = {
  'mercedesbenz': ['mercedes', 'mercedesbenz'],
  'vag': ['vw', 'volkswagen', 'vag'],
  'landrover': ['landrover'],
  'greatwall': ['greatwall'],
  'aisin': ['aisin']
};

function normalizeBrand(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

function canonicalBrand(value) {
  const normalized = normalizeBrand(value);
  for (const [canonical, aliases] of Object.entries(BRAND_ALIASES)) {
    if (aliases.includes(normalized)) return canonical;
  }
  return normalized;
}

function normalizeArticle(value) {
  return String(value || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '');
}

const maxRetries = Math.max(1, Math.min(3, parseInt(process.env.MAX_REQUEST_RETRIES || '3', 10)));
const PROXY_LEASE_TIMEOUT_MS = Math.max(1000, parseInt(process.env.PROXY_LEASE_TIMEOUT_MS || '120000', 10));
const PROXY_POOL_RECOVERY_MAX_MS = Math.max(
  PROXY_LEASE_TIMEOUT_MS,
  parseInt(process.env.PROXY_POOL_RECOVERY_MAX_MS || String(35 * 60 * 1000), 10)
);
const PROXY_POOL_RECOVERY_BACKOFF_MS = Math.max(
  1000,
  parseInt(process.env.PROXY_POOL_RECOVERY_BACKOFF_MS || String(60 * 1000), 10)
);
const CATALOG_CACHE_FILE = process.env.CATALOG_CACHE_FILE
  ? path.resolve(process.env.CATALOG_CACHE_FILE)
  : path.join(__dirname, 'catalog_id_cache.json');
const CATALOG_CACHE_META_KEY = '__meta';
const CATALOG_CACHE_SCHEMA_VERSION = 2;
const CATALOG_CACHE_SUCCESS_TTL_MS = Math.max(1, parseInt(process.env.CATALOG_CACHE_TTL_DAYS || '14', 10)) * 24 * 60 * 60 * 1000;
const CATALOG_CACHE_NEGATIVE_TTL_MS = Math.max(1, parseInt(process.env.CATALOG_CACHE_NEGATIVE_TTL_HOURS || '24', 10)) * 60 * 60 * 1000;
let catalogIdCache = null;
let catalogCacheSaveTimer = null;
const proxyAgentCache = new Map();
const catalogCacheTimerRegistry = global.__AUTOPITER_CATALOG_CACHE_TIMER_REGISTRY
  || (global.__AUTOPITER_CATALOG_CACHE_TIMER_REGISTRY = new Set());
const catalogCacheTimerHandle = {
  clear() {
    if (catalogCacheSaveTimer) {
      clearTimeout(catalogCacheSaveTimer);
      catalogCacheSaveTimer = null;
    }
  }
};
catalogCacheTimerRegistry.add(catalogCacheTimerHandle);

const tim = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function extractInputName(details = {}) {
  return details.inputName || details.name || details?.item?.Название || details?.item?.name || null;
}

function isCatalogMetaKey(key) {
  return key === CATALOG_CACHE_META_KEY || String(key || '').startsWith('__');
}

function isCatalogEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry);
}

function ensureCatalogCacheMeta(cache) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return cache;
  const nowIso = new Date().toISOString();
  if (!cache[CATALOG_CACHE_META_KEY] || typeof cache[CATALOG_CACHE_META_KEY] !== 'object') {
    cache[CATALOG_CACHE_META_KEY] = {
      schema: 'autopiter-catalog-cache',
      version: CATALOG_CACHE_SCHEMA_VERSION,
      createdAt: nowIso,
      updatedAt: nowIso
    };
  } else {
    cache[CATALOG_CACHE_META_KEY].schema = cache[CATALOG_CACHE_META_KEY].schema || 'autopiter-catalog-cache';
    cache[CATALOG_CACHE_META_KEY].version = CATALOG_CACHE_SCHEMA_VERSION;
    cache[CATALOG_CACHE_META_KEY].updatedAt = nowIso;
  }
  return cache;
}

function getCatalogCache() {
  if (catalogIdCache) return catalogIdCache;
  try {
    if (fs.existsSync(CATALOG_CACHE_FILE)) {
      catalogIdCache = JSON.parse(fs.readFileSync(CATALOG_CACHE_FILE, 'utf-8'));
    } else {
      catalogIdCache = {};
    }
  } catch (err) {
    console.log(`[catalog-cache] Failed to load cache: ${err.message}`);
    catalogIdCache = {};
  }
  ensureCatalogCacheMeta(catalogIdCache);
  return catalogIdCache;
}

function touchCatalogCacheMeta(cache = getCatalogCache()) {
  ensureCatalogCacheMeta(cache);
  cache[CATALOG_CACHE_META_KEY].version = CATALOG_CACHE_SCHEMA_VERSION;
  cache[CATALOG_CACHE_META_KEY].updatedAt = new Date().toISOString();
}

function flushCatalogCache() {
  for (const timerHandle of catalogCacheTimerRegistry) {
    if (timerHandle && typeof timerHandle.clear === 'function') {
      timerHandle.clear();
    }
  }
  try {
    fs.mkdirSync(path.dirname(CATALOG_CACHE_FILE), { recursive: true });
    fs.writeFileSync(CATALOG_CACHE_FILE, JSON.stringify(getCatalogCache(), null, 2), 'utf-8');
  } catch (err) {
    console.log(`[catalog-cache] Failed to save cache: ${err.message}`);
  }
}

function saveCatalogCacheDebounced() {
  if (catalogCacheSaveTimer) clearTimeout(catalogCacheSaveTimer);
  catalogCacheSaveTimer = setTimeout(() => {
    catalogCacheSaveTimer = null;
    flushCatalogCache();
  }, 2000);
  if (typeof catalogCacheSaveTimer.unref === 'function') {
    catalogCacheSaveTimer.unref();
  }
}

function legacyCatalogCacheKey(detailNumber, brand) {
  return `${String(brand || '').trim().toLowerCase()}|${String(detailNumber || '').trim().toLowerCase()}`;
}

function catalogCacheKey(detailNumber, brand) {
  return `${canonicalBrand(brand)}|${normalizeArticle(detailNumber)}`;
}

function catalogCacheKeys(detailNumber, brand) {
  const primary = catalogCacheKey(detailNumber, brand);
  const legacy = legacyCatalogCacheKey(detailNumber, brand);
  return primary === legacy ? [primary] : [primary, legacy];
}

function findCatalogCacheRecord(detailNumber, brand) {
  const cache = getCatalogCache();
  for (const key of catalogCacheKeys(detailNumber, brand)) {
    const entry = cache[key];
    if (isCatalogEntry(entry)) {
      return { key, entry };
    }
  }
  return { key: catalogCacheKey(detailNumber, brand), entry: undefined };
}

function buildCatalogEntry(detailNumber, brand, id, details = {}, previous = {}) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const entryBrand = details.brand || details?.item?.Марка || brand;
  const inputName = extractInputName(details) || previous.inputName || null;
  const autopiterName = details.autopiterName || previous.autopiterName || null;
  const status = details.status || (id ? 'resolved' : 'not_found');
  const entry = {
    ...previous,
    id: id === undefined || id === '' ? null : id,
    brand: entryBrand || previous.brand || null,
    canonicalBrand: canonicalBrand(entryBrand || brand),
    number: String(detailNumber || previous.number || ''),
    normalizedNumber: normalizeArticle(detailNumber || previous.number || ''),
    inputName,
    normalizedInputName: inputName ? normalizeName(inputName) : (previous.normalizedInputName || null),
    autopiterName,
    normalizedAutopiterName: autopiterName ? normalizeName(autopiterName) : (previous.normalizedAutopiterName || null),
    catalogName: details.catalogName || previous.catalogName || null,
    status,
    candidates: Array.isArray(details.candidates) ? details.candidates : undefined,
    createdAt: previous.createdAt || nowIso,
    updatedAt: nowIso,
    cachedAt: now,
    resolvedAt: id ? (details.resolvedAt || previous.resolvedAt || nowIso) : (previous.resolvedAt || null),
    verifiedAt: details.verified ? nowIso : (details.verifiedAt || previous.verifiedAt || null),
    lastSeenInInputAt: details.lastSeenInInputAt || previous.lastSeenInInputAt || null,
    lastValidationStatus: details.validationStatus || previous.lastValidationStatus || null,
    lastValidationReason: details.validationReason || previous.lastValidationReason || null,
    failCount: Number.isFinite(Number(previous.failCount)) ? Number(previous.failCount) : 0
  };
  if (!entry.candidates) delete entry.candidates;
  if (status === 'resolved') delete entry.staleReason;
  return entry;
}

function migrateCatalogEntry(detailNumber, brand, key, entry) {
  if (!isCatalogEntry(entry)) return entry;
  const primaryKey = catalogCacheKey(detailNumber, brand);
  const needsMigration = key !== primaryKey ||
    entry.brand === undefined ||
    entry.canonicalBrand === undefined ||
    entry.number === undefined ||
    entry.normalizedNumber === undefined ||
    entry.status === undefined;
  if (!needsMigration) return entry;

  const cache = getCatalogCache();
  const migrated = buildCatalogEntry(detailNumber, brand, entry.id, {
    status: entry.status || (entry.id === null || entry.id === undefined ? 'not_found' : 'resolved'),
    catalogName: entry.catalogName,
    candidates: entry.candidates,
    verifiedAt: entry.verifiedAt || null,
    lastSeenInInputAt: entry.lastSeenInInputAt || null,
    validationStatus: entry.lastValidationStatus || null,
    validationReason: entry.lastValidationReason || null
  }, entry);
  cache[primaryKey] = migrated;
  if (key !== primaryKey) delete cache[key];
  touchCatalogCacheMeta(cache);
  saveCatalogCacheDebounced();
  return migrated;
}

function getCachedCatalogEntry(detailNumber, brand) {
  const found = findCatalogCacheRecord(detailNumber, brand);
  if (!found.entry) return undefined;
  const entry = migrateCatalogEntry(detailNumber, brand, found.key, found.entry);
  if (!entry || entry.status === 'stale') return undefined;
  const ttl = entry.status === 'resolved' || (entry.id !== null && entry.id !== undefined)
    ? CATALOG_CACHE_SUCCESS_TTL_MS
    : CATALOG_CACHE_NEGATIVE_TTL_MS;
  if (Date.now() - (entry.cachedAt || 0) > ttl) return undefined;
  return entry;
}

function getCachedCatalogId(detailNumber, brand) {
  const entry = getCachedCatalogEntry(detailNumber, brand);
  if (!entry) return undefined;
  if (entry.status === 'ambiguous') return 'ambiguous';
  if (entry.status === 'stale') return undefined;
  return entry.id === null ? null : entry.id;
}

function setCachedCatalogId(detailNumber, brand, id, details = {}) {
  const cache = getCatalogCache();
  const primaryKey = catalogCacheKey(detailNumber, brand);
  const found = findCatalogCacheRecord(detailNumber, brand);
  const previous = found.entry || {};
  cache[primaryKey] = buildCatalogEntry(detailNumber, brand, id, details, previous);
  if (found.key && found.key !== primaryKey) delete cache[found.key];
  touchCatalogCacheMeta(cache);
  saveCatalogCacheDebounced();
}

function touchCatalogCacheInputItems(items = []) {
  const cache = getCatalogCache();
  const nowIso = new Date().toISOString();
  let updated = 0;
  for (const item of items) {
    if (!item) continue;
    const detailNumber = item.Номер || item.number || item.article;
    const brand = item.Марка || item.brand;
    if (!detailNumber || !brand) continue;
    const found = findCatalogCacheRecord(detailNumber, brand);
    if (!found.entry) continue;
    const entry = migrateCatalogEntry(detailNumber, brand, found.key, found.entry);
    const inputName = item.Название || item.name || entry.inputName || null;
    entry.brand = brand;
    entry.canonicalBrand = canonicalBrand(brand);
    entry.number = String(detailNumber || '');
    entry.normalizedNumber = normalizeArticle(detailNumber);
    entry.inputName = inputName;
    entry.normalizedInputName = inputName ? normalizeName(inputName) : null;
    entry.lastSeenInInputAt = nowIso;
    entry.updatedAt = nowIso;
    updated++;
  }
  if (updated > 0) {
    touchCatalogCacheMeta(cache);
    saveCatalogCacheDebounced();
  }
  return updated;
}

function markCatalogEntryStale(detailNumber, brand, id, reason, details = {}) {
  const cache = getCatalogCache();
  const key = catalogCacheKey(detailNumber, brand);
  const found = findCatalogCacheRecord(detailNumber, brand);
  const previous = found.entry || {};
  const nowIso = new Date().toISOString();
  const entry = buildCatalogEntry(detailNumber, brand, id || previous.id || null, {
    ...details,
    status: 'stale',
    validationStatus: 'stale',
    validationReason: reason
  }, previous);
  entry.staleReason = reason;
  entry.staleAt = nowIso;
  entry.failCount = (Number(previous.failCount) || 0) + 1;
  entry.updatedAt = nowIso;
  cache[key] = entry;
  if (found.key && found.key !== key) delete cache[found.key];
  touchCatalogCacheMeta(cache);
  saveCatalogCacheDebounced();
  return entry;
}

function updateCatalogEntryValidation(detailNumber, brand, id, details = {}) {
  const cache = getCatalogCache();
  const key = catalogCacheKey(detailNumber, brand);
  const found = findCatalogCacheRecord(detailNumber, brand);
  const previous = found.entry || {};
  const nowIso = new Date().toISOString();
  const entry = buildCatalogEntry(detailNumber, brand, id || previous.id || null, {
    ...details,
    status: 'resolved',
    verified: true,
    validationStatus: 'valid',
    validationReason: details.validationReason || 'appraise_match'
  }, previous);
  entry.verifiedAt = nowIso;
  entry.updatedAt = nowIso;
  entry.failCount = 0;
  cache[key] = entry;
  if (found.key && found.key !== key) delete cache[found.key];
  touchCatalogCacheMeta(cache);
  saveCatalogCacheDebounced();
  return entry;
}

function isCatalogIdCached(detailNumber, brand) {
  return getCachedCatalogId(detailNumber, brand) !== undefined;
}

function listMissingCatalogItems(items) {
  return items.filter(item => !isCatalogIdCached(item.Номер, item.Марка));
}

function getCatalogCacheStats(items = []) {
  const cache = getCatalogCache();
  const now = Date.now();
  let freshEntries = 0;
  let staleEntries = 0;
  let staleStatusEntries = 0;

  for (const [key, entry] of Object.entries(cache)) {
    if (isCatalogMetaKey(key)) continue;
    if (entry && entry.status === 'stale') staleStatusEntries++;
    const ttl = entry && (entry.status === 'resolved' || (entry.id !== null && entry.id !== undefined))
      ? CATALOG_CACHE_SUCCESS_TTL_MS
      : CATALOG_CACHE_NEGATIVE_TTL_MS;
    if (!entry || !entry.cachedAt || now - entry.cachedAt > ttl) {
      staleEntries++;
    } else {
      freshEntries++;
    }
  }

  return {
    file: CATALOG_CACHE_FILE,
    totalEntries: Object.keys(cache).filter(key => !isCatalogMetaKey(key)).length,
    freshEntries,
    staleEntries,
    staleStatusEntries,
    requestedItems: items.length,
    missingRequestedItems: items.length > 0 ? listMissingCatalogItems(items).length : 0
  };
}

function selectCatalog(catalogs, requestedBrand, requestedNumber) {
  const requestedCanonicalBrand = canonicalBrand(requestedBrand);
  const requestedArticle = normalizeArticle(requestedNumber);
  const candidates = (Array.isArray(catalogs) ? catalogs : []).filter(catalog => {
    return normalizeArticle(catalog.number) === requestedArticle &&
      canonicalBrand(catalog.catalogName) === requestedCanonicalBrand;
  });
  if (candidates.length === 1) {
    return { status: 'resolved', catalog: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    const uniqueIds = new Set(candidates.map(candidate => String(candidate.id)));
    if (uniqueIds.size === 1) {
      return { status: 'resolved', catalog: candidates[0], candidates };
    }
    return { status: 'ambiguous', catalog: null, candidates };
  }
  return { status: 'not_found', catalog: null, candidates: [] };
}

process.on('exit', () => {
  if (process.env.DISABLE_CATALOG_CACHE_EXIT_FLUSH !== '1') {
    flushCatalogCache();
  }
});

function encodeProxyValue(value) {
  return encodeURIComponent(String(value || ''));
}

function buildProxyAuthPart(username, pass) {
  if (!username && !pass) return '';
  return `${encodeProxyValue(username)}:${encodeProxyValue(pass)}@`;
}

function getCachedProxyAgents(proxy) {
  const protocol = proxy.protocol || 'http';
  const username = proxy.auth ? proxy.auth.username : '';
  const pass = proxy.auth ? proxy.auth.password : '';
  const key = `${protocol}|${proxy.host}|${proxy.port}|${username}|${pass}`;
  const cached = proxyAgentCache.get(key);
  if (cached) return cached;

  let agents;
  if (protocol === 'socks5' && SocksProxyAgent) {
    const socksUrl = `socks5h://${buildProxyAuthPart(username, pass)}${proxy.host}:${proxy.port}`;
    const socksAgent = new SocksProxyAgent(socksUrl, {
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 1,
      maxFreeSockets: 1
    });
    agents = {
      httpAgent: socksAgent,
      httpsAgent: socksAgent,
      label: `SOCKS5 proxy ${proxy.host}:${proxy.port}`
    };
  } else {
    const proxyUrl = `${protocol}://${buildProxyAuthPart(username, pass)}${proxy.host}:${proxy.port}`;
    agents = {
      httpAgent: new httpProxyAgent.HttpProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 1,
        maxFreeSockets: 1
      }),
      httpsAgent: new httpsProxyAgent.HttpsProxyAgent(proxyUrl, {
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 1,
        maxFreeSockets: 1
      }),
      label: `${protocol.toUpperCase()} proxy ${proxy.host}:${proxy.port}`
    };
  }

  proxyAgentCache.set(key, agents);
  return agents;
}

function destroyProxyAgentCache() {
  for (const agents of proxyAgentCache.values()) {
    for (const agent of [agents.httpAgent, agents.httpsAgent]) {
      if (agent && typeof agent.destroy === 'function') {
        agent.destroy();
      }
    }
  }
  proxyAgentCache.clear();
}

function getAdaptiveDelay(kind, fallbackMin, fallbackMax) {
  const { getWorkingProxiesCount, getTimingConfig } = require('./prox.js');
  const count = getWorkingProxiesCount();
  const timing = getTimingConfig();
  
  let multiplier = 1.0;
  if (count <= 5) {
    multiplier = 1.4;   // Very few proxies — moderate slowdown
  } else if (count <= 15) {
    multiplier = 1.1;
  } else if (count <= 30) {
    multiplier = 1.0;
  }
  // 30+ proxies — no slowdown needed
  
  const min = kind === 'appraise' ? timing.appraiseDelayMinMs : timing.searchDelayMinMs;
  const max = kind === 'appraise' ? timing.appraiseDelayMaxMs : timing.searchDelayMaxMs;
  const baseMin = Number.isFinite(min) ? min : fallbackMin;
  const baseMax = Math.max(baseMin, Number.isFinite(max) ? max : fallbackMax);
  const baseDelay = baseMin + Math.random() * (baseMax - baseMin);
  return baseDelay * multiplier;
}

async function getId(id, name, targetProxy = null, options = {}) {
  const forceRefresh = Boolean(options && options.forceRefresh);
  const cachedId = forceRefresh ? undefined : getCachedCatalogId(id, name);
  if (!forceRefresh && cachedId !== undefined) {
    return cachedId;
  }

  try {
    const res = await get(`https://autopiter.ru/api/api/searchdetails?meta[frontendType]=1&meta[renderType]=1&meta[routeId]=APPRAISE_CATALOGS&detailNumber=${encodeURIComponent(id)}&isFullQuery=true`, targetProxy, `https://autopiter.ru/goods/${encodeURIComponent(id)}`);
    if (!res || !res.data) {
      return 'err';
    }
    
    const abody = res.data;
    if (!abody.data || !abody.data.catalogs) {
      return null;
    }

    const selected = selectCatalog(abody.data.catalogs, name, id);
    const candidateSummary = selected.candidates.map(candidate => ({
      id: candidate.id,
      catalogName: candidate.catalogName,
      number: candidate.number
    }));
    if (selected.status === 'resolved') {
      setCachedCatalogId(id, name, selected.catalog.id, {
        status: 'resolved',
        catalogName: selected.catalog.catalogName,
        brand: name,
        inputName: options.inputName || null
      });
      return selected.catalog.id;
    }
    setCachedCatalogId(id, name, null, {
      status: selected.status,
      candidates: candidateSummary,
      brand: name,
      inputName: options.inputName || null
    });
    return selected.status === 'ambiguous' ? 'ambiguous' : null;
  } catch (err) {
    return 'err';
  }
}

function processAppraiseOffers(i, apply) {
  if (!apply || apply.length === 0) return null;
  const mn = apply.reduce((prev, current) => {
    return (prev.price < current.price) ? prev : current;
  });
  
  const rs = [];
  for (const check of apply) {
    const mc = mn.price;
    const smc = String(mc).replace('.', ',');
    
    const obj = { 
      'Артикул': i.Номер, 
      'Бренд': check.catalogName || i.Марка, 
      'Продавец': check.priceId, 
      'Цена': check.price, 
      'Наша_Цена': i.цена, 
      'Мин_Цена': smc, 
      'Наличие': check.quantity, 
      'Срок доставки': check.deliveryDays,
      'Продукт': check.name || i.Название || ''
    };
    rs.push(obj);
  }
  return rs;
}

function getOfferIdentity(offer = {}) {
  return {
    brand: canonicalBrand(offer.catalogName || offer.brand || ''),
    article: normalizeArticle(offer.shortName || offer.number || offer.article || ''),
    articleId: offer.articleId === undefined || offer.articleId === null ? '' : String(offer.articleId),
    name: offer.name || offer.detailName || offer.productName || null,
    catalogName: offer.catalogName || null
  };
}

function validateCatalogIdFromAppraise(item, id, offers = []) {
  const reqBrand = canonicalBrand(item.Марка);
  const reqArticle = normalizeArticle(item.Номер);
  const selectedId = String(id);
  let hasIdentitySignals = false;
  let firstProductName = null;

  for (const offer of offers) {
    const identity = getOfferIdentity(offer);
    if (!firstProductName && identity.name) firstProductName = identity.name;
    const hasArticleSignal = Boolean(identity.article || identity.articleId);
    if (!hasArticleSignal) continue;
    hasIdentitySignals = true;
    const brandMatches = !identity.brand || identity.brand === reqBrand;
    const articleMatches = identity.article && identity.article === reqArticle;
    const idMatches = identity.articleId && identity.articleId === selectedId;
    if (brandMatches && (articleMatches || idMatches)) {
      return {
        status: 'valid',
        reason: articleMatches ? 'brand_article_match' : 'brand_article_id_match',
        autopiterName: firstProductName || identity.name || null,
        catalogName: identity.catalogName || null
      };
    }
  }

  if (offers.length > 0 && hasIdentitySignals) {
    return {
      status: 'stale',
      reason: 'appraise_identity_mismatch',
      autopiterName: firstProductName,
      catalogName: offers[0]?.catalogName || null
    };
  }

  return {
    status: 'unknown',
    reason: offers.length === 0 ? 'no_appraise_offers' : 'missing_identity_fields',
    autopiterName: firstProductName,
    catalogName: offers[0]?.catalogName || null
  };
}

async function getInfo(i, id, targetProxy = null) {
  try {
    // 1. Fetch Moscow offers first
    const res = await get(`https://autopiter.ru/api/api/appraise?id=${id}&meta[frontendType]=1&meta[renderType]=1&meta[routeId]=APPRAISE_PRODUCT`, targetProxy, `https://autopiter.ru/goods/${encodeURIComponent(i.Номер)}`);
    if (!res || !res.data) {
      return 'err';
    }
    
    const body = res.data;
    if (!body || body.error) {
      return 'err';
    }

    let offers = [];
    if (body.data) {
      if (body.data.appriseInfo) {
        offers = body.data.appriseInfo;
      } else if (Array.isArray(body.data)) {
        offers = body.data;
      }
    } else {
      return 'err';
    }
    
    const validation = validateCatalogIdFromAppraise(i, id, offers);
    if (validation.status === 'stale') {
      markCatalogEntryStale(i.Номер, i.Марка, id, validation.reason, {
        item: i,
        autopiterName: validation.autopiterName,
        catalogName: validation.catalogName
      });
      return 'stale_id';
    }
    if (validation.status === 'valid') {
      updateCatalogEntryValidation(i.Номер, i.Марка, id, {
        item: i,
        autopiterName: validation.autopiterName,
        catalogName: validation.catalogName,
        validationReason: validation.reason
      });
    }

    const apply = [];
    const reqBrand = canonicalBrand(i.Марка);
    const reqArticle = normalizeArticle(i.Номер);
    const selectedId = String(id);
    const seenOffers = new Set();
    for (const o of offers) {
      const deliveryDays = Number(o.deliveryDays);
      const quantity = Number(o.quantity);
      const price = Number(o.price);
      const offerBrand = canonicalBrand(o.catalogName);
      const offerArticle = normalizeArticle(o.shortName);
      const exactArticleId = String(o.articleId || '') === selectedId;
      const exactBrandAndNumber = offerBrand === reqBrand && offerArticle === reqArticle;
      const offerKey = String(o.detailUid || `${o.priceId}|${o.id}|${o.price}`);
      if (!Number.isFinite(deliveryDays) || deliveryDays < 0 || deliveryDays > 7) continue;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      if (offerBrand !== reqBrand || (!exactArticleId && !exactBrandAndNumber)) continue;
      if (seenOffers.has(offerKey)) continue;
      seenOffers.add(offerKey);
      apply.push(o);
    }
    
    if (apply.length > 0) {
      return processAppraiseOffers(i, apply);
    }
    
    return null;
  } catch (err) {
    return 'err';
  }
}

function normalizeProxyParam(param) {
  if (param && typeof param === 'object' && 'rp' in param) {
    return param;
  }
  return { rp: param };
}

async function get(url, forceProxy = null, referer = 'https://autopiter.ru/') {
  const wrapper = normalizeProxyParam(forceProxy);
  const {
    markProxyBad,
    resetSoftBlock,
    getProxyCookie,
    setProxyCookie,
    getProxyGuestCookie,
    setProxyGuestCookie,
    getFingerprint,
    recordProxyResult,
    acquireRequestSlot,
    acquireProxyLease,
    canUseDirectFallback,
    isGuestMode,
    mergeCookies,
    getDirectCookie,
    updateDirectCookie
  } = require('./prox.js');

  const requestStartedAt = Date.now();
  let proxyPoolWaits = 0;
  let attempt = 1;
  while (attempt <= maxRetries) {
    let lease = null;
    let releaseRequestSlot = null;
    let proxy = null;
    let ua = {};
    let forcedProxy = false;
    let forcedDirect = false;
    let outcome = 'success';
    let options = {};
    try {
      if (wrapper.rp && wrapper.rp !== 'none' && wrapper.rp !== 'direct') {
        proxy = wrapper.rp;
        ua = getFingerprint(proxy);
        forcedProxy = true;
      } else if (wrapper.rp === 'direct') {
        forcedDirect = true;
        ua.Cookie = getDirectCookie();
      } else {
        lease = await acquireProxyLease({ timeoutMs: PROXY_LEASE_TIMEOUT_MS });
        proxy = lease.proxy;
        ua = lease.ua;
      }

      if (proxy) {
        const cookie = isGuestMode() ? getProxyGuestCookie(proxy) : getProxyCookie(proxy);
        if (!isGuestMode() && (!cookie || !cookie.includes('sessionId='))) {
          outcome = 'auth_issue';
          if (!lease) markProxyBad(proxy, 'auth_issue');
          wrapper.rp = null;
          continue;
        }
        ua.Cookie = cookie;
      }

      const headers = {
        'User-Agent': ua['User-Agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': ua['accept-language'] || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Connection': 'keep-alive',
        'sec-ch-ua': ua['sec-ch-ua'] || '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': ua['sec-ch-ua-mobile'] || '?0',
        'sec-ch-ua-platform': ua['sec-ch-ua-platform'] || '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'Referer': referer,
        'x-ap-request-id': crypto.randomBytes(16).toString('base64url')
      };
      if (ua.Cookie) {
        headers.Cookie = ua.Cookie;
      }
      const axiosOptions = {
        headers,
        timeout: Math.min(15000 * Math.pow(2, attempt - 1), 45000),
        validateStatus: status => status >= 200 && status < 300
      };
      let proxyStr = 'Direct Connection';
      if (proxy) {
        const agents = getCachedProxyAgents(proxy);
        proxyStr = agents.label;
        axiosOptions.httpAgent = agents.httpAgent;
        axiosOptions.httpsAgent = agents.httpsAgent;
      }

      releaseRequestSlot = await acquireRequestSlot(proxy);
      const requestKind = url.includes('/api/api/appraise') ? 'appraise' : (url.includes('/api/api/searchdetails') ? 'search' : 'request');
      const requestDelayMs = getAdaptiveDelay(requestKind, 0, 0);
      if (requestDelayMs > 0) {
        await tim(requestDelayMs);
      }
      const res = await axios.get(url, axiosOptions);
      const contentType = String(res.headers['content-type'] || '');
      const responseText = typeof res.data === 'string' ? res.data.toLowerCase() : '';
      if (contentType.includes('text/html') && (
        responseText.includes('challenge') ||
        responseText.includes('captcha') ||
        responseText.includes('вы очень активный') ||
        responseText.includes('я не робот')
      )) {
        const challengeError = new Error('HTML challenge response');
        challengeError.code = 'AUTOPITER_CHALLENGE';
        throw challengeError;
      }
      if (res.headers['x-ap-user-type'] === 'guest' && !isGuestMode()) {
        const sessionError = new Error('Logged session became guest');
        sessionError.code = 'AUTOPITER_SESSION_EXPIRED';
        throw sessionError;
      }

      if (res.headers['set-cookie']) {
        if (proxy && isGuestMode()) {
          setProxyGuestCookie(proxy, mergeCookies(getProxyGuestCookie(proxy), res.headers['set-cookie']));
        } else if (proxy) {
          setProxyCookie(proxy, mergeCookies(getProxyCookie(proxy), res.headers['set-cookie']));
        } else {
          updateDirectCookie(mergeCookies(getDirectCookie(), res.headers['set-cookie']));
        }
      }

      if (proxy) {
        resetSoftBlock(proxy);
        if (lease) lease.release('success');
        else recordProxyResult(proxy, 'success');
      }
      lease = null;
      return res;
    } catch (error) {
      const status = error.response && error.response.status;
      const label = proxy ? `${proxy.host}:${proxy.port}` : (error.code === 'PROXY_LEASE_TIMEOUT' ? 'proxy-pool' : 'direct');
      console.log(`[get] Attempt ${attempt}/${maxRetries} failed via ${label}: ${error.message}`);
      if (error.code === 'PROXY_LEASE_TIMEOUT' && !forcedDirect && !forcedProxy) {
        const waitedMs = Date.now() - requestStartedAt;
        if (waitedMs < PROXY_POOL_RECOVERY_MAX_MS) {
          proxyPoolWaits++;
          const remainingMs = PROXY_POOL_RECOVERY_MAX_MS - waitedMs;
          const baseDelayMs = Math.min(PROXY_POOL_RECOVERY_BACKOFF_MS, remainingMs);
          const delayMs = Math.max(1000, Math.round(baseDelayMs * (0.75 + Math.random() * 0.5)));
          console.log(`[get] Proxy pool unavailable; waiting ${Math.round(delayMs / 1000)}s before retrying the same request attempt (pool wait #${proxyPoolWaits}).`);
          await tim(delayMs);
          continue;
        }
      } else if (proxy && (status === 429 || status === 403)) {
        outcome = 'rate_limited';
        if (!lease) markProxyBad(proxy, 'rate_limited');
        wrapper.rp = null;
        const retryAfter = String(error.response?.headers?.['retry-after'] || '');
        const seconds = Number(retryAfter);
        const retryAfterMs = Number.isFinite(seconds) && seconds > 0
          ? Math.min(seconds * 1000, 30 * 60 * 1000)
          : 0;
        options = { retryAfterMs };
      } else if (proxy && (status === 401 || error.code === 'AUTOPITER_SESSION_EXPIRED' || error.code === 'AUTOPITER_CHALLENGE')) {
        outcome = 'auth_issue';
        if (!isGuestMode()) setProxyCookie(proxy, null);
        if (!lease) markProxyBad(proxy, error.code === 'AUTOPITER_CHALLENGE' ? 'challenge' : 'auth_issue');
        wrapper.rp = null;
      } else if (proxy) {
        outcome = 'network';
        options = { attempt };
        if (!lease) markProxyBad(proxy, 'network');
        wrapper.rp = null;
      } else if (!canUseDirectFallback() && !forcedDirect) {
        wrapper.rp = null;
      }
    } finally {
      if (releaseRequestSlot) releaseRequestSlot(outcome, options);
      if (lease) lease.release(outcome);
    }
    attempt++;
  }
  console.log(`[get] Request failed after ${maxRetries} classified attempts: ${url}`);
  return null;
}

module.exports = {
  tim,
  getId,
  getInfo,
  get,
  getCachedCatalogId,
  getCachedCatalogEntry,
  setCachedCatalogId,
  markCatalogEntryStale,
  updateCatalogEntryValidation,
  touchCatalogCacheInputItems,
  isCatalogIdCached,
  listMissingCatalogItems,
  getCatalogCacheStats,
  flushCatalogCache,
  destroyProxyAgentCache,
  normalizeBrand,
  canonicalBrand,
  normalizeArticle,
  normalizeName,
  selectCatalog,
  validateCatalogIdFromAppraise,
  processAppraiseOffers
};
