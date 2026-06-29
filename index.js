const express = require('express');
const app = express();
const port = 8081;
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
process.setMaxListeners(100);
const {
  tim,
  getId,
  getInfo,
  getCachedCatalogId,
  listMissingCatalogItems,
  getCatalogCacheStats,
  flushCatalogCache,
  touchCatalogCacheInputItems
} = require('./ax.js');
const { getDetails, getProxies, final, positions, horizontal } = require('./files.js');
const {
  initprox,
  USE_PROXIES,
  getAuthMode,
  setRuntimeAuthMode,
  getProxyPoolSnapshot,
  getParserConcurrency,
  getTimingConfig,
  getAccountCount,
  getAllAccounts,
  MAX_ACTIVE_PER_ACCOUNT_SAFE,
  MAX_ACTIVE_PER_ACCOUNT_HARD,
  ACCOUNT_REQUEST_CONCURRENCY,
  GUEST_REQUEST_CONCURRENCY,
  GUEST_MAX_ACTIVE_PROXIES,
  canUseDirectFallback
} = require('./prox.js');

let isRunning = false;
let shouldAbort = false;
const metrics = {
  parser_runs_total: 0,
  parser_rows_total: 0,
  parser_errors_total: 0,
  parser_checkpoint_loaded_total: 0,
  catalog_prefetch_runs_total: 0,
  catalog_prefetch_resolved_total: 0,
  catalog_prefetch_failed_total: 0,
  last_run_duration_seconds: 0,
  last_run_timestamp: null,
  last_run_status: 'never_run'
};

function readBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function readPositiveIntEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readPositiveFloatEnv(name, fallback) {
  const value = Number(process.env[name] || '');
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatDuration(ms) {
  if (ms < 0 || isNaN(ms) || !isFinite(ms)) return '0s';
  const totalSecs = Math.round(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  let res = '';
  if (hrs > 0) res += `${hrs}h `;
  if (mins > 0 || hrs > 0) res += `${mins}m `;
  res += `${secs}s`;
  return res;
}

function isPlaceholderAccountUsername(username) {
  return ['client123', 'client456'].includes(String(username || '').trim().toLowerCase());
}

function isLoopbackProxyHost(proxy) {
  const host = String(proxy?.host || '').trim().toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
}

function getCheckpointFile() {
  return process.env.CHECKPOINT_FILE
    ? path.resolve(process.env.CHECKPOINT_FILE)
    : path.join(__dirname, 'runtime', 'parser_checkpoint.jsonl');
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function getItemKey(item) {
  return [
    normalizeText(item.Марка),
    normalizeText(item.Номер),
    normalizeText(item.Название),
    normalizeText(item.цена),
    normalizeText(item.партия),
    normalizeText(item['кол-во'])
  ].join('|');
}

function getCheckpointStatus(result) {
  if (!result) return 'retryable_error';
  if (result.success && result.count > 0) return 'success';
  if (result.success) return 'no_offers';
  if (result.reason === 'no_id' || result.reason === 'not_found') return 'not_found';
  if (result.reason === 'ambiguous') return 'ambiguous';
  return 'retryable_error';
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendCheckpoint(record) {
  if (!readBooleanEnv('CHECKPOINT_ENABLED', true)) return;
  const checkpointFile = getCheckpointFile();
  ensureParentDir(checkpointFile);
  fs.appendFileSync(
    checkpointFile,
    JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n',
    'utf-8'
  );
}

function loadCheckpoint(items) {
  if (!readBooleanEnv('RESUME_CHECKPOINT', true)) {
    return new Map();
  }

  const checkpointFile = getCheckpointFile();
  if (!fs.existsSync(checkpointFile)) {
    return new Map();
  }

  const allowedKeys = new Set(items.map(getItemKey));
  const completed = new Map();
  const maxAgeHours = readPositiveIntEnv('CHECKPOINT_MAX_AGE_HOURS', 6);
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const lines = fs.readFileSync(checkpointFile, 'utf-8').split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (!record || !record.key || !allowedKeys.has(record.key)) continue;
      const recordTime = record.at ? new Date(record.at).getTime() : Date.now();
      if (!Number.isFinite(recordTime) || Date.now() - recordTime > maxAgeMs) continue;

      if (record.status === 'success' || record.status === 'no_offers' || record.status === 'not_found' || record.status === 'no_id') {
        completed.set(record.key, record);
      } else if (record.status === 'retryable_error' || record.status === 'error' || record.status === 'ambiguous') {
        completed.delete(record.key);
      }
    } catch (err) {
      console.log(`[Checkpoint] Skipping malformed checkpoint line: ${err.message}`);
    }
  }

  return completed;
}

function getManifestFile() {
  return process.env.RUN_MANIFEST_FILE
    ? path.resolve(process.env.RUN_MANIFEST_FILE)
    : path.join(__dirname, 'runtime', 'parser_manifest.json');
}

function buildRunManifest(items) {
  const latest = new Map();
  const checkpointFile = getCheckpointFile();
  if (fs.existsSync(checkpointFile)) {
    for (const line of fs.readFileSync(checkpointFile, 'utf-8').split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        if (record && record.key) latest.set(record.key, record);
      } catch (err) {
        // Malformed lines are already reported by checkpoint loading.
      }
    }
  }

  const rows = items.map(item => {
    const key = getItemKey(item);
    const record = latest.get(key);
    return {
      key,
      article: item.Номер,
      brand: item.Марка,
      status: record?.status || 'missing',
      attemptsComplete: !!record,
      offerCount: record?.count || 0,
      catalogId: record?.id || null,
      updatedAt: record?.at || null
    };
  });
  const counts = rows.reduce((result, row) => {
    result[row.status] = (result[row.status] || 0) + 1;
    return result;
  }, {});
  const unresolvedStatuses = new Set(['missing', 'retryable_error', 'error', 'ambiguous']);
  const unresolved = rows.filter(row => unresolvedStatuses.has(row.status));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    inputItems: items.length,
    counts,
    unresolvedCount: unresolved.length,
    complete: unresolved.length === 0,
    unresolved,
    rows
  };
}

function writeRunManifest(items) {
  const manifest = buildRunManifest(items);
  const manifestFile = getManifestFile();
  ensureParentDir(manifestFile);
  const temporaryFile = `${manifestFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.renameSync(temporaryFile, manifestFile);
  console.log(`[Manifest] ${manifest.complete ? 'COMPLETE' : 'INCOMPLETE'}: ${manifest.inputItems} items, unresolved=${manifest.unresolvedCount}. File: ${manifestFile}`);
  return manifest;
}

function restoreCheckpointResults(completedRecords, main, un) {
  for (const record of completedRecords.values()) {
    const offers = Array.isArray(record.offers) ? record.offers : [];
    for (const offer of offers) {
      un.add(JSON.stringify({ 'Артикул': offer.Артикул, 'Бренд': offer.Бренд }));
      main.push(offer);
    }
  }
}

function buildProductionDiagnostics(items) {
  const checkpointRecords = loadCheckpoint(items);
  const remainingItems = items.filter(item => !checkpointRecords.has(getItemKey(item)));
  const catalogStats = getCatalogCacheStats(remainingItems);
  const proxies = getProxies();
  const timing = getTimingConfig();
  const accounts = getAllAccounts();
  const accountCount = Math.max(1, accounts.length || getAccountCount());
  const placeholderAccountCount = accounts.filter(account => isPlaceholderAccountUsername(account.username)).length;
  const loopbackProxyCount = proxies.filter(isLoopbackProxyHost).length;
  const accountLanes = Math.max(1, ACCOUNT_REQUEST_CONCURRENCY);
  const guestLanes = Math.max(1, GUEST_REQUEST_CONCURRENCY);
  const avgAccountIntervalMs = (timing.accountIntervalMinMs + timing.accountIntervalMaxMs) / 2;
  const avgGuestIntervalMs = (timing.guestIntervalMinMs + timing.guestIntervalMaxMs) / 2;
  const loggedCapacity = Math.max(1, accountCount * accountLanes);
  const prefetchConcurrency = readPositiveIntEnv('CATALOG_PREFETCH_CONCURRENCY', Math.max(4, guestLanes * 4));
  const guestActiveProxyEstimate = Math.max(
    1,
    Math.min(
      proxies.length || prefetchConcurrency,
      prefetchConcurrency,
      GUEST_MAX_ACTIVE_PROXIES
    )
  );
  const cachedNullIds = remainingItems.filter(item => getCachedCatalogId(item.Номер, item.Марка) === null).length;
  const priceRequestUpperBound = Math.max(0, remainingItems.length - cachedNullIds);
  const prefetchEtaMs = catalogStats.missingRequestedItems > 0
    ? (catalogStats.missingRequestedItems / guestLanes) * avgGuestIntervalMs * readPositiveFloatEnv('PREFETCH_ETA_OVERHEAD', 1.2)
    : 0;
  const loggedEtaMs = priceRequestUpperBound > 0
    ? (priceRequestUpperBound / loggedCapacity) * avgAccountIntervalMs * 1.15
    : 0;
  const totalEtaMs = prefetchEtaMs + loggedEtaMs;
  const targetMs = readPositiveIntEnv('TARGET_RUN_HOURS', 3) * 60 * 60 * 1000;
  const requiredAccounts = priceRequestUpperBound > 0
    ? Math.ceil((priceRequestUpperBound * avgAccountIntervalMs * 1.15) / targetMs / accountLanes)
    : 0;

  const warnings = [];
  if (accounts.length === 0) {
    warnings.push('No real Autopiter accounts are configured; restore logins.txt before logged scraping.');
  }
  if (placeholderAccountCount > 0) {
    warnings.push(`Placeholder test accounts detected (${placeholderAccountCount}); replace client123/client456 in logins.txt before production.`);
  }
  if (loopbackProxyCount > 0) {
    warnings.push(`Loopback/test proxies detected (${loopbackProxyCount}); use PROXY_SOURCE=api or restore real proxies.txt before production.`);
  }
  if (accountCount < 2) {
    warnings.push('Only one account is configured; logged price parsing is unlikely to finish within 3 hours safely.');
  }
  if (proxies.length < accountCount * MAX_ACTIVE_PER_ACCOUNT_SAFE) {
    warnings.push(`Proxy count ${proxies.length} is below safe active capacity ${accountCount * MAX_ACTIVE_PER_ACCOUNT_SAFE}.`);
  }
  if (catalogStats.missingRequestedItems > 0) {
    warnings.push(`${catalogStats.missingRequestedItems} catalog IDs are not cached; run CATALOG_PREFETCH_ONLY=1 first to keep logged sessions for prices.`);
  }
  if (loggedEtaMs > targetMs) {
    warnings.push(`Estimated logged price phase is ${formatDuration(loggedEtaMs)}, above target ${formatDuration(targetMs)}. Add accounts or lower ACCOUNT_REQUEST_INTERVAL_* only after stable test.`);
  }
  if (totalEtaMs > targetMs) {
    warnings.push(`Estimated total runtime is ${formatDuration(totalEtaMs)}, above target ${formatDuration(targetMs)}. Warm catalog cache first and re-run diagnostics.`);
  }
  if (getAuthMode() === 'guest' && !readBooleanEnv('ALLOW_GUEST_PRICE_MODE', false)) {
    warnings.push('AUTH_MODE=guest will be switched to logged for price parsing because logged user data is required.');
  }
  if (canUseDirectFallback()) {
    warnings.push('Direct fallback is enabled; in proxy production mode this can consume an extra account session slot.');
  }

  return {
    createdAt: new Date().toISOString(),
    inputItems: items.length,
    checkpoint: {
      file: getCheckpointFile(),
      restoredItems: checkpointRecords.size,
      remainingItems: remainingItems.length,
      maxAgeHours: readPositiveIntEnv('CHECKPOINT_MAX_AGE_HOURS', 6)
    },
    catalogCache: catalogStats,
    catalogPrefetchPhase: {
      estimatedRequests: catalogStats.missingRequestedItems,
      estimatedActiveProxies: guestActiveProxyEstimate,
      estimatedConcurrency: prefetchConcurrency,
      requestLanes: guestLanes,
      requestIntervalMinMs: timing.guestIntervalMinMs,
      requestIntervalMaxMs: timing.guestIntervalMaxMs,
      estimatedDurationMs: Math.round(prefetchEtaMs),
      estimatedDuration: formatDuration(prefetchEtaMs)
    },
    proxies: {
      configured: proxies.length,
      loopbackDetected: loopbackProxyCount,
      sourceRequiresBoundIp: true,
      note: 'This diagnostic does not test proxy connectivity or login sessions.'
    },
    accounts: {
      configured: accounts.length,
      schedulerCount: accountCount,
      placeholderDetected: placeholderAccountCount,
      safeActivePerAccount: MAX_ACTIVE_PER_ACCOUNT_SAFE,
      hardActivePerAccount: MAX_ACTIVE_PER_ACCOUNT_HARD,
      requestLanesPerAccount: accountLanes,
      accountIntervalMinMs: timing.accountIntervalMinMs,
      accountIntervalMaxMs: timing.accountIntervalMaxMs
    },
    pricePhase: {
      authMode: getAuthMode(),
      loggedDataRequired: true,
      estimatedPriceRequests: priceRequestUpperBound,
      estimatedDurationMs: Math.round(loggedEtaMs),
      estimatedDuration: formatDuration(loggedEtaMs),
      targetDuration: formatDuration(targetMs),
      estimatedFitsTarget: loggedEtaMs <= targetMs,
      requiredAccountsForTarget: requiredAccounts
    },
    totalRuntime: {
      estimatedDurationMs: Math.round(totalEtaMs),
      estimatedDuration: formatDuration(totalEtaMs),
      targetDuration: formatDuration(targetMs),
      estimatedFitsTarget: totalEtaMs <= targetMs
    },
    parser: {
      concurrency: USE_PROXIES ? getParserConcurrency() : 1,
      directFallbackEnabled: canUseDirectFallback(),
      scrapeProfile: timing.profile
    },
    warnings
  };
}

function printProductionDiagnostics(diagnostics) {
  console.log(`\n==================================================`);
  console.log(`Autopiter production diagnostics`);
  console.log(`==================================================`);
  console.log(`Input items: ${diagnostics.inputItems}`);
  console.log(`Checkpoint restored: ${diagnostics.checkpoint.restoredItems}; remaining: ${diagnostics.checkpoint.remainingItems}`);
  console.log(`Catalog cache missing: ${diagnostics.catalogCache.missingRequestedItems}/${diagnostics.catalogCache.requestedItems}`);
  console.log(`Accounts: ${diagnostics.accounts.configured}; proxies: ${diagnostics.proxies.configured}`);
  console.log(`Active logged capacity: ${diagnostics.accounts.safeActivePerAccount}/account safe, ${diagnostics.accounts.hardActivePerAccount}/account hard`);
  console.log(`Account scheduler: lanes=${diagnostics.accounts.requestLanesPerAccount}, interval=${diagnostics.accounts.accountIntervalMinMs}-${diagnostics.accounts.accountIntervalMaxMs}ms`);
  console.log(`Guest prefetch scheduler: lanes=${diagnostics.catalogPrefetchPhase.requestLanes}, interval=${diagnostics.catalogPrefetchPhase.requestIntervalMinMs}-${diagnostics.catalogPrefetchPhase.requestIntervalMaxMs}ms, workers=${diagnostics.catalogPrefetchPhase.estimatedConcurrency}`);
  console.log(`Estimated catalog prefetch: ${diagnostics.catalogPrefetchPhase.estimatedDuration} for ${diagnostics.catalogPrefetchPhase.estimatedRequests} request(s)`);
  console.log(`Estimated logged price phase: ${diagnostics.pricePhase.estimatedDuration} for ${diagnostics.pricePhase.estimatedPriceRequests} request(s)`);
  console.log(`Estimated total runtime: ${diagnostics.totalRuntime.estimatedDuration}`);
  console.log(`3h target fit: ${diagnostics.totalRuntime.estimatedFitsTarget ? 'YES' : 'NO'}; required accounts estimate: ${diagnostics.pricePhase.requiredAccountsForTarget}`);
  if (diagnostics.warnings.length > 0) {
    console.log(`Warnings:`);
    for (const warning of diagnostics.warnings) {
      console.log(`- ${warning}`);
    }
  } else {
    console.log(`Warnings: none`);
  }
  console.log(`==================================================\n`);
}

async function runDiagnosticsOnly() {
  const items = getDetails();
  const diagnostics = buildProductionDiagnostics(items);
  printProductionDiagnostics(diagnostics);
  if (process.env.DIAGNOSTICS_JSON === '1') {
    console.log(JSON.stringify(diagnostics, null, 2));
  }
  return diagnostics;
}

async function runBounded(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!shouldAbort && nextIndex < items.length) {
      const currentIndex = nextIndex++;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function runCatalogPrefetch(items) {
  const enabled = readBooleanEnv('PREFETCH_CATALOG_IDS', true);
  const prefetchOnly = readBooleanEnv('CATALOG_PREFETCH_ONLY', false);
  const forceRefresh = readBooleanEnv('CATALOG_CACHE_REFRESH', false);
  touchCatalogCacheInputItems(items);
  const stats = getCatalogCacheStats(items);

  if (!enabled) {
    console.log(`[Catalog Prefetch] Disabled. Cache fresh=${stats.freshEntries}, stale=${stats.staleEntries}, missing=${stats.missingRequestedItems}/${items.length}.`);
    return { skipped: true, reason: 'disabled' };
  }

  let missingItems = forceRefresh ? items.slice() : listMissingCatalogItems(items);
  const limit = parseInt(process.env.CATALOG_PREFETCH_LIMIT || '0', 10);
  if (Number.isFinite(limit) && limit > 0 && missingItems.length > limit) {
    missingItems = missingItems.slice(0, limit);
  }

  if (missingItems.length === 0) {
    console.log(`[Catalog Prefetch] Cache is warm. Missing catalog IDs: 0/${items.length}.`);
    return { skipped: true, reason: 'cache_warm' };
  }

  const restoreMode = getAuthMode();
  const requestedMode = String(process.env.CATALOG_PREFETCH_AUTH_MODE || 'guest').trim().toLowerCase();
  const prefetchMode = requestedMode === 'logged' ? 'logged' : 'guest';
  const defaultConcurrency = prefetchMode === 'guest' ? Math.max(4, GUEST_REQUEST_CONCURRENCY * 4) : Math.max(1, getParserConcurrency());
  const concurrency = readPositiveIntEnv('CATALOG_PREFETCH_CONCURRENCY', defaultConcurrency);
  const startedAt = Date.now();
  let processed = 0;
  let resolved = 0;
  let notFound = 0;
  let failed = 0;

  console.log(`\n==================================================`);
  console.log(`[Catalog Prefetch] Resolving ${missingItems.length}/${items.length} ${forceRefresh ? 'catalog IDs by force refresh' : 'missing catalog IDs'} before price parsing.`);
  console.log(`[Catalog Prefetch] Mode=${prefetchMode}, concurrency=${concurrency}, cache=${stats.file}`);
  console.log(`==================================================\n`);

  metrics.catalog_prefetch_runs_total++;
  setRuntimeAuthMode(prefetchMode);

  try {
    await initprox();
    await tim(1000);

    await runBounded(missingItems, concurrency, async (item, index) => {
      try {
        const catalogId = await getId(item.Номер, item.Марка, null, {
          forceRefresh,
          inputName: item.Название || null
        });

        if (catalogId === 'err') {
          failed++;
        } else if (catalogId === 'ambiguous') {
          notFound++;
        } else if (!catalogId) {
          notFound++;
        } else {
          resolved++;
        }
      } catch (err) {
        failed++;
        console.log(`[Catalog Prefetch] ${item.Марка} ${item.Номер} failed: ${err.message}`);
      }

      processed++;
      if (processed % 25 === 0 || processed === missingItems.length || index === 0) {
        const elapsedMs = Date.now() - startedAt;
        const rate = processed / Math.max(elapsedMs / 60000, 0.001);
        const etaMs = (missingItems.length - processed) / Math.max(rate, 0.001) * 60000;
        console.log(`[Catalog Prefetch] ${processed}/${missingItems.length} | resolved=${resolved}, not_found=${notFound}, failed=${failed} | ETA ${formatDuration(etaMs)}`);
      }
    });
  } finally {
    flushCatalogCache();
    metrics.catalog_prefetch_resolved_total += resolved;
    metrics.catalog_prefetch_failed_total += failed;
    setRuntimeAuthMode(restoreMode);
  }

  console.log(`\n==================================================`);
  console.log(`[Catalog Prefetch] Finished in ${formatDuration(Date.now() - startedAt)}. resolved=${resolved}, not_found=${notFound}, failed=${failed}.`);
  console.log(`[Catalog Prefetch] ${prefetchOnly ? 'CATALOG_PREFETCH_ONLY=1: main price parsing will be skipped.' : 'Main price parsing will continue in logged/current auth mode.'}`);
  console.log(`==================================================\n`);

  return { processed, resolved, notFound, failed };
}


process.on('uncaughtException', function (err) {
  console.error("Uncaught Exception:", err);
});

async function processItem(item, index, total) {
  const prefix = `[Part ${index}/${total}] ${item.Марка} ${item.Номер}`;
  const cachedId = getCachedCatalogId(item.Номер, item.Марка);
  console.log(`${prefix} - \x1b[36mSTART\x1b[0m: ${cachedId !== undefined ? 'Catalog ID cache hit.' : 'Searching catalog ID...'}`);
  
  try {
    let id = cachedId !== undefined ? cachedId : await getId(item.Номер, item.Марка, null, {
      inputName: item.Название || null
    });
    if (id === 'err') {
      console.log(`${prefix} - \x1b[31mERROR\x1b[0m: Failed to search catalog ID due to network/API error.`);
      return { success: false, reason: 'retryable_error', item };
    }
    if (id === 'ambiguous') {
      console.log(`${prefix} - \x1b[33mAMBIGUOUS\x1b[0m: Several exact catalog candidates found.`);
      return { success: false, reason: 'ambiguous', item };
    }
    if (!id) {
      console.log(`${prefix} - \x1b[33mSKIPPED\x1b[0m: No matching brand/number catalog ID found on Autopiter.`);
      return { success: false, reason: 'no_id', item };
    }
    
    console.log(`${prefix} - ID found: ${id}. \x1b[36mFetching offers...\x1b[0m`);
    let mymass = await getInfo(item, id);
    if (mymass === 'stale_id') {
      console.log(`${prefix} - \x1b[33mSTALE ID\x1b[0m: Cached ID ${id} no longer matches appraise response. Refreshing catalog ID...`);
      const refreshedId = await getId(item.Номер, item.Марка, null, {
        forceRefresh: true,
        inputName: item.Название || null
      });
      if (refreshedId === 'err') {
        console.log(`${prefix} - \x1b[31mERROR\x1b[0m: Failed to refresh stale catalog ID.`);
        return { success: false, reason: 'retryable_error', item, id };
      }
      if (refreshedId === 'ambiguous') {
        console.log(`${prefix} - \x1b[33mAMBIGUOUS\x1b[0m: Refresh found several exact catalog candidates.`);
        return { success: false, reason: 'ambiguous', item, id };
      }
      if (!refreshedId) {
        console.log(`${prefix} - \x1b[33mSKIPPED\x1b[0m: Refresh found no matching brand/number catalog ID.`);
        return { success: false, reason: 'no_id', item, id };
      }
      id = refreshedId;
      console.log(`${prefix} - Refreshed ID: ${id}. \x1b[36mFetching offers again...\x1b[0m`);
      mymass = await getInfo(item, id);
    }
    
    if (mymass === 'err') {
      console.log(`${prefix} - \x1b[31mERROR\x1b[0m: Failed to fetch prices from API.`);
      return { success: false, reason: 'retryable_error', item, id };
    } else if (mymass === 'stale_id') {
      console.log(`${prefix} - \x1b[31mERROR\x1b[0m: Refreshed catalog ID still mismatches appraise response.`);
      return { success: false, reason: 'retryable_error', item, id };
    } else if (!mymass || mymass.length === 0) {
      console.log(`${prefix} - \x1b[33mNO OFFERS\x1b[0m: No prices under delivery filters.`);
      return { success: true, count: 0 };
    } else {
      const minPrice = mymass[0].Мин_Цена;
      console.log(`${prefix} - \x1b[32mSUCCESS\x1b[0m: Found ${mymass.length} offers. Min Price: ${minPrice} руб.`);
      return { success: true, count: mymass.length, data: mymass };
    }
  } catch (err) {
    console.log(`${prefix} - \x1b[31mCRITICAL ERROR\x1b[0m: ${err.message}`);
    return { success: false, reason: 'error', item };
  }
}

function summarizeOffers(result) {
  if (!result || !result.success) {
    return {
      ok: false,
      reason: result ? result.reason : 'missing_result',
      count: 0,
      minPrice: null,
      sellers: []
    };
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  const prices = rows.map(row => Number(row.Цена)).filter(Number.isFinite);
  return {
    ok: true,
    count: rows.length,
    minPrice: prices.length > 0 ? Math.min(...prices) : null,
    sellers: Array.from(new Set(rows.map(row => row.Продавец).filter(Boolean))).sort()
  };
}

async function fetchComparisonSnapshot(item, index, total, label) {
  const prefix = `[${label} ${index}/${total}] ${item.Марка} ${item.Номер}`;
  try {
    const id = await getId(item.Номер, item.Марка);
    if (id === 'err' || id === 'ambiguous' || !id) {
      return { success: false, reason: id === 'err' ? 'id_error' : (id === 'ambiguous' ? 'ambiguous' : 'no_id'), id: id || null };
    }
    const offers = await getInfo(item, id);
    if (offers === 'err') {
      return { success: false, reason: 'offers_error', id };
    }
    if (offers === 'stale_id') {
      return { success: false, reason: 'stale_id', id };
    }
    return { success: true, id, data: offers || [] };
  } catch (err) {
    console.log(`${prefix} comparison failed: ${err.message}`);
    return { success: false, reason: 'exception', error: err.message };
  }
}

function isGuestComparisonCompatible(rows) {
  const comparable = rows.filter(row => row.logged.summary.ok && row.guest.summary.ok);
  if (comparable.length === 0) return false;
  return comparable.every(row => {
    return row.logged.id === row.guest.id &&
      row.logged.summary.count === row.guest.summary.count &&
      row.logged.summary.minPrice === row.guest.summary.minPrice;
  });
}

async function runGuestComparison(sampleItems) {
  const originalMode = getAuthMode();
  const sampleSize = Math.min(
    Math.max(1, parseInt(process.env.GUEST_COMPARE_SAMPLE || '20', 10)),
    sampleItems.length
  );
  const sample = sampleItems.slice(0, sampleSize);
  const rows = [];

  console.log(`[Auth Auto] Comparing logged vs guest mode on ${sample.length} item(s)...`);
  const loggedSnapshots = [];
  for (let i = 0; i < sample.length; i++) {
    loggedSnapshots.push(await fetchComparisonSnapshot(sample[i], i + 1, sample.length, 'Logged Compare'));
  }

  setRuntimeAuthMode('guest');
  await initprox();
  await tim(1000);

  const guestSnapshots = [];
  for (let i = 0; i < sample.length; i++) {
    guestSnapshots.push(await fetchComparisonSnapshot(sample[i], i + 1, sample.length, 'Guest Compare'));
  }

  for (let i = 0; i < sample.length; i++) {
    const logged = loggedSnapshots[i];
    const guest = guestSnapshots[i];
    rows.push({
      article: sample[i].Номер,
      brand: sample[i].Марка,
      logged: {
        id: logged.id || null,
        summary: summarizeOffers(logged)
      },
      guest: {
        id: guest.id || null,
        summary: summarizeOffers(guest)
      }
    });
  }

  const compatible = isGuestComparisonCompatible(rows);
  const report = {
    createdAt: new Date().toISOString(),
    sampleSize: sample.length,
    compatible,
    rows
  };
  const reportPath = path.join(__dirname, `guest_comparison_${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[Auth Auto] Guest comparison report saved: ${reportPath}`);
  console.log(`[Auth Auto] Guest mode compatibility: ${compatible ? 'YES' : 'NO'}`);

  if (!compatible) {
    setRuntimeAuthMode('logged');
    await initprox();
    await tim(1000);
  } else if (originalMode !== 'guest') {
    setRuntimeAuthMode('guest');
  }

  return compatible;
}

async function start() {
  if (isRunning) {
    console.log("[Scraper] Scraper is already running. Skipping execution trigger.");
    return;
  }
  
  isRunning = true;
  shouldAbort = false;
  metrics.parser_runs_total++;
  metrics.last_run_timestamp = new Date().toISOString();
  metrics.last_run_status = 'running';
  const startTime = Date.now();
  
  console.log("Initializing scraper...");
  try {
    let main = [];
    let errored = [];
    let un = new Set();
    
    let dets = getDetails();
    if (dets.length === 0) {
      console.log("No input items found to process. Exiting start().");
      isRunning = false;
      metrics.last_run_status = 'success_empty';
      metrics.last_run_duration_seconds = 0;
      return;
    }
    const originalTotal = dets.length;

    const scrapeLimit = parseInt(process.env.SCRAPE_LIMIT || '0', 10);
    if (scrapeLimit > 0 && dets.length > scrapeLimit) {
      dets = dets.slice(0, scrapeLimit);
      console.log(`[Scraper] SCRAPE_LIMIT=${scrapeLimit}; processing only first ${dets.length} item(s).`);
    }

    const prefetchOnly = readBooleanEnv('CATALOG_PREFETCH_ONLY', false);
    if (prefetchOnly) {
      console.log(`[Checkpoint] Ignored in catalog prefetch-only mode. Cache build will scan ${dets.length} input item(s).`);
    } else {
      const checkpointRecords = loadCheckpoint(dets);
      if (checkpointRecords.size > 0) {
        restoreCheckpointResults(checkpointRecords, main, un);
        const beforeResumeFilter = dets.length;
        dets = dets.filter(item => !checkpointRecords.has(getItemKey(item)));
        metrics.parser_checkpoint_loaded_total += checkpointRecords.size;
        console.log(`[Checkpoint] Restored ${checkpointRecords.size}/${beforeResumeFilter} completed item(s) from ${getCheckpointFile()}. Remaining this run: ${dets.length}.`);
      } else {
        console.log(`[Checkpoint] No reusable checkpoint records found. File: ${getCheckpointFile()}`);
      }
    }

    if (!prefetchOnly && getAuthMode() === 'auto') {
      await initprox();
      await tim(2000);
      await runGuestComparison(dets);
    }

    await runCatalogPrefetch(dets);

    if (prefetchOnly) {
      metrics.last_run_status = shouldAbort ? 'aborted' : 'prefetch_only';
      return;
    }

    if (getAuthMode() === 'guest' && !readBooleanEnv('ALLOW_GUEST_PRICE_MODE', false)) {
      console.log(`[Auth] Main price parsing requires logged mode. Switching from guest to logged. Set ALLOW_GUEST_PRICE_MODE=1 only for explicit guest-price experiments.`);
      setRuntimeAuthMode('logged');
    }

    await initprox();
    await tim(2000);
    
    const total = dets.length;
    let processedCount = 0;
    const loopStartTime = Date.now();
    
    const timingConfig = getTimingConfig();
    const concurrency = USE_PROXIES ? getParserConcurrency() : 1;
    console.log(`\n==================================================`);
    console.log(`Starting parallel parsing of ${total} details...`);
    console.log(`Concurrency limit: ${concurrency} parallel workers (optimized for ${USE_PROXIES ? 'proxy-rotation' : 'direct-mode'})`);
    console.log(`==================================================\n`);
    
    const pool = [];
    const activeWorkers = new Set();
    
    for (let i = 0; i < dets.length; i++) {
      if (shouldAbort) {
        console.log(`[Scraper] Abort signal detected. Halting main scraping loop.`);
        break;
      }
      const item = dets[i];
      const index = i + 1;
      
      const workerPromise = (async () => {
        if (shouldAbort) return;
        if (!USE_PROXIES) {
          const delayMs = 8000 + Math.random() * 7000;
          console.log(`[Direct Connection] Waiting ${Math.round(delayMs / 100) / 10}s before item #${index} to avoid rate limiting...`);
          await tim(delayMs);
        } else {
          const jitter = timingConfig.startupJitterMs;
          if (jitter > 0) {
            await tim((index * 137) % jitter);
          }
        }
        
        metrics.parser_rows_total++;
        const result = await processItem(item, index, total);
        appendCheckpoint({
          key: getItemKey(item),
          index,
          total,
          status: getCheckpointStatus(result),
          reason: result.reason || null,
          id: result.id || null,
          item,
          count: result.count || 0,
          offers: Array.isArray(result.data) ? result.data : []
        });

        if (result.success && result.count > 0) {
          for (const offer of result.data) {
            un.add(JSON.stringify({ 'Артикул': item.Номер, 'Бренд': offer.Бренд }));
            main.push(offer);
          }
        } else if (!result.success) {
          if (result.reason === 'error') {
            metrics.parser_errors_total++;
            errored.push({ item: result.item, id: result.id, index });
          }
        }
        
        processedCount++;
        const elapsedMs = Date.now() - loopStartTime;
        const pct = ((processedCount / total) * 100).toFixed(1);
        const avgTimePerItem = elapsedMs / processedCount;
        const remainingItems = total - processedCount;
        const etaMs = remainingItems * avgTimePerItem;
        
        const barLength = 20;
        const filledLength = Math.round((processedCount / total) * barLength);
        const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
        
        console.log(`[Progress] [${bar}] ${processedCount}/${total} (${pct}%) | Elapsed: ${formatDuration(elapsedMs)} | ETA: ${formatDuration(etaMs)}`);
      })();
      
      pool.push(workerPromise);
      activeWorkers.add(workerPromise);
      workerPromise.then(() => activeWorkers.delete(workerPromise));
      
      if (activeWorkers.size >= concurrency) {
        await Promise.race(activeWorkers);
      }
    }
    
    await Promise.all(pool);
    
    // Round 2: Retry Round (with Concurrency limit = 1 and extended timeouts)
    if (errored.length > 0 && !shouldAbort) {
      console.log(`\n==================================================`);
      console.log(`=== Starting Round 2: Retry of ${errored.length} failed items ===`);
      console.log(`==================================================\n`);
      
      const retryPool = [];
      const retryActiveWorkers = new Set();
      const retryConcurrency = 1; // Round 2 limit = 1 to minimize proxy load
      
      const retryTotal = errored.length;
      let retryProcessedCount = 0;
      const retryStartTime = Date.now();
      
      for (let k = 0; k < errored.length; k++) {
        if (shouldAbort) {
          console.log(`[Scraper] Abort signal detected. Halting retry loop.`);
          break;
        }
        const { item, id: firstPassId, index } = errored[k];
        
        const workerPromise = (async () => {
          if (shouldAbort) return;
          const prefix = `[Retry ${k + 1}/${errored.length}] (Orig #${index}) ${item.Марка} ${item.Номер}`;
          
          // Wait longer between retries
          const delayMs = USE_PROXIES ? (4000 + Math.random() * 4000) : (8000 + Math.random() * 6000);
          await tim(delayMs);
          
          try {
            let id = firstPassId;
            if (!id) {
              console.log(`${prefix} - \x1b[36mRETRY START\x1b[0m: Searching catalog ID first...`);
              const retryId = await getId(item.Номер, item.Марка, null, {
                inputName: item.Название || null
              });
              if (retryId === 'err' || retryId === 'ambiguous' || !retryId) {
                console.log(`${prefix} - \x1b[31mRETRY FAILED\x1b[0m: Failed to resolve catalog ID.`);
                appendCheckpoint({
                  key: getItemKey(item),
                  index,
                  total: retryTotal,
                  retry: true,
                  status: retryId === 'err' ? 'retryable_error' : (retryId === 'ambiguous' ? 'ambiguous' : 'not_found'),
                  reason: retryId === 'err' ? 'retryable_error' : (retryId === 'ambiguous' ? 'ambiguous' : 'not_found'),
                  id: retryId || null,
                  item,
                  count: 0,
                  offers: []
                });
                if (retryId === 'err') {
                  metrics.parser_errors_total++;
                }
                return;
              }
              id = retryId;
            }
            
            console.log(`${prefix} - \x1b[36mRETRY START\x1b[0m: Re-fetching offers with ID ${id}...`);
            let mymass = await getInfo(item, id);
            if (mymass === 'stale_id') {
              console.log(`${prefix} - \x1b[33mRETRY STALE ID\x1b[0m: Cached ID ${id} mismatched. Refreshing...`);
              const refreshedId = await getId(item.Номер, item.Марка, null, {
                forceRefresh: true,
                inputName: item.Название || null
              });
              if (refreshedId === 'err' || refreshedId === 'ambiguous' || !refreshedId) {
                console.log(`${prefix} - \x1b[31mRETRY FAILED\x1b[0m: Failed to refresh stale catalog ID.`);
                appendCheckpoint({
                  key: getItemKey(item),
                  index,
                  total: retryTotal,
                  retry: true,
                  status: refreshedId === 'err' ? 'retryable_error' : (refreshedId === 'ambiguous' ? 'ambiguous' : 'not_found'),
                  reason: refreshedId === 'err' ? 'retryable_error' : (refreshedId === 'ambiguous' ? 'ambiguous' : 'not_found'),
                  id,
                  item,
                  count: 0,
                  offers: []
                });
                if (refreshedId === 'err') metrics.parser_errors_total++;
                return;
              }
              id = refreshedId;
              console.log(`${prefix} - \x1b[36mRETRY START\x1b[0m: Re-fetching offers with refreshed ID ${id}...`);
              mymass = await getInfo(item, id);
            }
            
            if (mymass === 'err') {
              console.log(`${prefix} - \x1b[31mRETRY FAILED\x1b[0m.`);
              appendCheckpoint({
                key: getItemKey(item),
                index,
                total: retryTotal,
                retry: true,
                status: 'retryable_error',
                reason: 'retryable_error',
                id,
                item,
                count: 0,
                offers: []
              });
              metrics.parser_errors_total++;
            } else if (mymass === 'stale_id') {
              console.log(`${prefix} - \x1b[31mRETRY FAILED\x1b[0m: Refreshed catalog ID still mismatches appraise response.`);
              appendCheckpoint({
                key: getItemKey(item),
                index,
                total: retryTotal,
                retry: true,
                status: 'retryable_error',
                reason: 'stale_id',
                id,
                item,
                count: 0,
                offers: []
              });
              metrics.parser_errors_total++;
            } else if (!mymass || mymass.length === 0) {
              console.log(`${prefix} - \x1b[33mRETRY NO OFFERS\x1b[0m.`);
              appendCheckpoint({
                key: getItemKey(item),
                index,
                total: retryTotal,
                retry: true,
                status: 'no_offers',
                reason: null,
                id,
                item,
                count: 0,
                offers: []
              });
            } else {
              const minPrice = mymass[0].Мин_Цена;
              console.log(`${prefix} - \x1b[32mRETRY SUCCESS\x1b[0m: Found ${mymass.length} offers. Min Price: ${minPrice} руб.`);
              appendCheckpoint({
                key: getItemKey(item),
                index,
                total: retryTotal,
                retry: true,
                status: 'success',
                reason: null,
                id,
                item,
                count: mymass.length,
                offers: mymass
              });
              for (const j of mymass) {
                un.add(JSON.stringify({ 'Артикул': item.Номер, 'Бренд': j.Бренд }));
                main.push(j);
              }
            }
          } catch (err) {
            console.log(`${prefix} - \x1b[31mRETRY CRITICAL ERROR\x1b[0m: ${err.message}`);
            appendCheckpoint({
              key: getItemKey(item),
              index,
              total: retryTotal,
              retry: true,
              status: 'error',
              reason: 'error',
              item,
              count: 0,
              offers: []
            });
            metrics.parser_errors_total++;
          }
          
          retryProcessedCount++;
          const elapsedMs = Date.now() - retryStartTime;
          const pct = ((retryProcessedCount / retryTotal) * 100).toFixed(1);
          const avgTimePerItem = elapsedMs / retryProcessedCount;
          const remainingItems = retryTotal - retryProcessedCount;
          const etaMs = remainingItems * avgTimePerItem;
          
          const barLength = 20;
          const filledLength = Math.round((retryProcessedCount / retryTotal) * barLength);
          const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
          
          console.log(`[Retry Progress] [${bar}] ${retryProcessedCount}/${retryTotal} (${pct}%) | Elapsed: ${formatDuration(elapsedMs)} | ETA: ${formatDuration(etaMs)}`);
        })();
        
        retryPool.push(workerPromise);
        retryActiveWorkers.add(workerPromise);
        workerPromise.then(() => retryActiveWorkers.delete(workerPromise));
        
        if (retryActiveWorkers.size >= retryConcurrency) {
          await Promise.race(retryActiveWorkers);
        }
      }
      
      await Promise.all(retryPool);
    }
    
    console.log(`\n==================================================`);
    console.log(`Parsing finished. Total offers collected: ${main.length}`);
    if (processedCount > 0 && originalTotal > processedCount) {
      const elapsedMs = Date.now() - loopStartTime;
      const estimatedFullMs = (elapsedMs / processedCount) * originalTotal;
      const rowsPerMinute = processedCount / Math.max(elapsedMs / 60000, 0.001);
      console.log(`Throughput estimate: ${rowsPerMinute.toFixed(1)} details/min | full ${originalTotal} details ETA: ${formatDuration(estimatedFullMs)}`);
    }
    console.log(`==================================================\n`);
    
    if (process.env.DRY_RUN === '1') {
      console.log("\x1b[33mDRY_RUN=1: Reports skipped by request.\x1b[0m");
    } else if (main.length > 0 && !shouldAbort) {
      console.log("Generating Excel reports...");
      final(main);
      positions(main, un);
      horizontal(main, un);
      console.log("\x1b[32mSUCCESS: All reports generated successfully.\x1b[0m");
    } else if (shouldAbort) {
      console.log("\x1b[33mRun was aborted by user request. Reports skipped.\x1b[0m");
    } else {
      console.log("\x1b[31mNo data collected, output Excel reports skipped.\x1b[0m");
    }
    
    metrics.last_run_status = shouldAbort ? 'aborted' : 'success';
  } catch (err) {
    console.error("[Scraper] Critical run error:", err);
    metrics.last_run_status = 'failed';
    metrics.parser_errors_total++;
  } finally {
    const endTime = Date.now();
    metrics.last_run_duration_seconds = Math.round((endTime - startTime) / 1000);
    isRunning = false;
    shouldAbort = false;
    
    // Close browser pool sessions to release memory resources
    try {
      const pupp = require('./pupp.js');
      await pupp.closeAllSessions();
    } catch (cleanupErr) {
      console.log("Failed to close browser sessions: " + cleanupErr.message);
    }
  }
}

// REST API Endpoints
app.get('/start', (req, res) => {
  if (isRunning) {
    return res.status(400).json({ status: 'error', message: 'Scraper is already running' });
  }
  shouldAbort = false;
  start()
    .then(() => console.log("Web triggered scraping completed."))
    .catch((err) => console.error("Web triggered scraping failed:", err));
  res.json({ status: 'success', message: 'Scraping started in background.' });
});

app.get('/get', (req, res) => {
  if (isRunning) {
    return res.status(400).send('ERROR - Scraper is already running.');
  }
  shouldAbort = false;
  start()
    .then(() => console.log("Web triggered scraping completed."))
    .catch((err) => console.error("Web triggered scraping failed:", err));
  res.send('OK - Scraping started in background. Check terminal console for logs.');
});

app.get('/stop', (req, res) => {
  if (!isRunning) {
    return res.status(400).json({ status: 'error', message: 'Scraper is not running.' });
  }
  shouldAbort = true;
  res.json({ status: 'success', message: 'Stop signal sent. The scraper will abort on the next iteration.' });
});

app.get('/proxies/reload', async (req, res) => {
  try {
    console.log("Reloading proxies via API request...");
    await initprox();
    res.json({ status: 'success', message: 'Proxies reloaded and verified.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/proxies/status', (req, res) => {
  res.json({
    status: 'success',
    pool: getProxyPoolSnapshot()
  });
});

app.get('/diagnostics', (req, res) => {
  try {
    const items = getDetails();
    res.json({
      status: 'success',
      diagnostics: buildProductionDiagnostics(items)
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/metrics', (req, res) => {
  if (req.query.format === 'json') {
    return res.json(metrics);
  }
  let promText = `# HELP parser_runs_total Total number of parser runs initiated.\n# TYPE parser_runs_total counter\nparser_runs_total ${metrics.parser_runs_total}\n\n`;
  promText += `# HELP parser_rows_total Total number of rows parsed/processed.\n# TYPE parser_rows_total counter\nparser_rows_total ${metrics.parser_rows_total}\n\n`;
  promText += `# HELP parser_errors_total Total number of errors encountered during parsing.\n# TYPE parser_errors_total counter\nparser_errors_total ${metrics.parser_errors_total}\n\n`;
  promText += `# HELP parser_checkpoint_loaded_total Total completed item records restored from checkpoint.\n# TYPE parser_checkpoint_loaded_total counter\nparser_checkpoint_loaded_total ${metrics.parser_checkpoint_loaded_total}\n\n`;
  promText += `# HELP catalog_prefetch_runs_total Total number of catalog prefetch phases initiated.\n# TYPE catalog_prefetch_runs_total counter\ncatalog_prefetch_runs_total ${metrics.catalog_prefetch_runs_total}\n\n`;
  promText += `# HELP catalog_prefetch_resolved_total Total catalog IDs resolved during prefetch.\n# TYPE catalog_prefetch_resolved_total counter\ncatalog_prefetch_resolved_total ${metrics.catalog_prefetch_resolved_total}\n\n`;
  promText += `# HELP catalog_prefetch_failed_total Total catalog ID prefetch failures.\n# TYPE catalog_prefetch_failed_total counter\ncatalog_prefetch_failed_total ${metrics.catalog_prefetch_failed_total}\n\n`;
  promText += `# HELP last_run_duration_seconds Duration of the last completed run in seconds.\n# TYPE last_run_duration_seconds gauge\nlast_run_duration_seconds ${metrics.last_run_duration_seconds}\n\n`;
  promText += `# HELP parser_active Indicates if the parser is currently running (1 = active, 0 = idle).\n# TYPE parser_active gauge\nparser_active ${isRunning ? 1 : 0}\n`;
  res.set('Content-Type', 'text/plain');
  res.send(promText);
});

// Chron Scheduler: runs daily at 20:20 MSK
if (process.env.NODE_ENV !== 'test') {
  cron.schedule('20 20 * * *', () => {
    console.log('[Scheduler] Running scheduled daily parse at 20:20 local time...');
    start()
      .then(() => console.log('[Scheduler] Scheduled daily parse completed.'))
      .catch((err) => console.error('[Scheduler] Scheduled daily parse failed:', err));
  });
}

const diagnosticsMode = process.argv.includes('--diagnostics') || process.env.DIAGNOSTICS_ONLY === '1';
const catalogCacheMode = process.argv.includes('--catalog-cache') || process.argv.includes('--build-catalog-cache');
if (catalogCacheMode) {
  process.env.CATALOG_PREFETCH_ONLY = '1';
  process.env.PREFETCH_CATALOG_IDS = process.env.PREFETCH_CATALOG_IDS || '1';
}

if (!process.argv.includes('--direct') && !diagnosticsMode && !catalogCacheMode && process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`==================================================`);
    console.log(`Express app listening on port ${port}`);
    console.log(`To start scraping:`);
    console.log(`1. Visit http://localhost:${port}/start`);
    console.log(`2. Visit http://localhost:${port}/stop to abort`);
    console.log(`3. Visit http://localhost:${port}/proxies/status for proxy pool status`);
    console.log(`4. Visit http://localhost:${port}/diagnostics for production readiness diagnostics`);
    console.log(`5. Visit http://localhost:${port}/metrics for Prometheus statistics`);
    console.log(`6. Run the script directly with: node index.js --direct`);
    console.log(`7. Run diagnostics without scraping with: node index.js --diagnostics`);
    console.log(`==================================================`);
  });
} else if (process.argv.includes('--direct') || catalogCacheMode) {
  console.log(catalogCacheMode
    ? "Catalog cache build mode enabled. Skipping Express server startup."
    : "Direct scraping mode enabled (--direct flag detected). Skipping Express server startup.");
}

if (diagnosticsMode) {
  console.log("Diagnostics mode enabled. Scraper will not start.");
  runDiagnosticsOnly()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Diagnostics failed:", err);
      process.exit(1);
    });
} else if (process.argv.includes('--direct') || catalogCacheMode) {
  console.log(catalogCacheMode ? "Catalog cache build mode enabled. Scraper will only create/update catalog_id_cache.json." : "Direct scraping mode enabled (--direct flag detected).");
  setTimeout(() => {
    start()
      .then(() => {
        console.log("Scraping completed. Exiting...");
        process.exit(0);
      })
      .catch((err) => {
        console.error("Scraping failed:", err);
        process.exit(1);
      });
  }, 1000);
}

// Clean exit handler to terminate Puppeteer sessions on Ctrl+C or SIGTERM
let exiting = false;
async function handleExit(signal) {
  if (exiting) return;
  exiting = true;
  console.log(`\n[Scraper] Received ${signal}. Cleaning up and exiting...`);
  try {
    const pupp = require('./pupp.js');
    await pupp.closeAllSessions();
    const { flushProxySessions } = require('./prox.js');
    flushProxySessions();
  } catch (err) {
    console.error("Error during exit cleanup:", err);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

module.exports = {
  start,
  loadCheckpoint,
  appendCheckpoint,
  buildRunManifest,
  writeRunManifest,
  runCatalogPrefetch,
  runDiagnosticsOnly,
  runGuestComparison,
  getItemKey,
  getCheckpointFile,
  getManifestFile
};
