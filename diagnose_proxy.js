/**
 * Comprehensive proxy diagnostics script.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getProxies } = require('./files.js');

const SESSIONS_FILE = path.join(__dirname, 'proxy_sessions.json');

async function testProxyConnectivity(proxyIP, proxyPort, username, password) {
  const socksUrl = `socks5h://${username}:${password}@${proxyIP}:${proxyPort}`;
  const agent = new SocksProxyAgent(socksUrl);
  try {
    const res = await axios.get('https://autopiter.ru/api/api/searchdetails?detailNumber=AAT024', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://autopiter.ru/',
        'X-Requested-With': 'XMLHttpRequest'
      },
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000
    });
    return {
      status: res.status,
      userType: res.headers['x-ap-user-type'],
      isJson: typeof res.data === 'object',
      catalogs: res.data?.data?.catalogs?.length || 0
    };
  } catch (err) {
    return { error: err.message, status: err.response?.status };
  }
}

async function testProxyWithCookies(proxyIP, proxyPort, username, password, cookies) {
  const socksUrl = `socks5h://${username}:${password}@${proxyIP}:${proxyPort}`;
  const agent = new SocksProxyAgent(socksUrl);
  try {
    const res = await axios.get('https://autopiter.ru/api/api/searchdetails?detailNumber=AAT024', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cookies,
        'Referer': 'https://autopiter.ru/',
        'X-Requested-With': 'XMLHttpRequest'
      },
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000
    });
    return {
      status: res.status,
      userType: res.headers['x-ap-user-type'],
      isJson: typeof res.data === 'object',
      catalogs: res.data?.data?.catalogs?.length || 0
    };
  } catch (err) {
    return { error: err.message, status: err.response?.status };
  }
}

async function main() {
  console.log('========================================');
  console.log('   AUTOPITER PROXY DIAGNOSTICS');
  console.log('========================================\n');

  // 1. Check proxy_sessions.json
  console.log('--- 1. PROXY SESSIONS CACHE ---');
  let cachedData = { directCookie: '', proxySessions: {}, accountSessions: {} };
  try {
    cachedData = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
    const cachedCount = Object.keys(cachedData.proxySessions || {}).length;
    console.log(`✓ proxy_sessions.json exists`);
    console.log(`  Direct cookie: ${cachedData.directCookie ? 'present (' + cachedData.directCookie.length + ' chars)' : 'EMPTY'}`);
    console.log(`  Cached proxy sessions: ${cachedCount}`);
    for (const [ip, cookie] of Object.entries(cachedData.proxySessions || {})) {
      if (cookie) {
        const hasSessionId = cookie.includes('sessionId=');
        console.log(`    ${ip}: ${cookie.length} chars, sessionId: ${hasSessionId ? 'YES' : 'NO'}`);
      } else {
        console.log(`    ${ip}: NULL/EMPTY (invalidated)`);
      }
    }
  } catch (err) {
    console.log(`✗ proxy_sessions.json error: ${err.message}`);
  }

  // 2. Check proxies.txt
  console.log('\n--- 2. PROXIES FILE ---');
  const allProxies = getProxies();
  console.log(`Total proxies in file: ${allProxies.length}`);

  // 3. Match cached vs file
  console.log('\n--- 3. CACHE HIT ANALYSIS ---');
  let matchCount = 0;
  let nullCount = 0;
  for (const p of allProxies) {
    const cached = cachedData.proxySessions[p.host];
    if (cached) matchCount++;
    else if (cached === null) nullCount++;
  }
  console.log(`  Cached & valid: ${matchCount} / ${allProxies.length}`);
  console.log(`  Cached but NULL (invalidated): ${nullCount}`);
  console.log(`  Not cached: ${allProxies.length - matchCount - nullCount}`);

  // 4. Test direct connection
  console.log('\n--- 4. DIRECT CONNECTION TEST ---');
  try {
    const res = await axios.get('https://autopiter.ru/api/api/searchdetails?detailNumber=AAT024', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': cachedData.directCookie,
        'Referer': 'https://autopiter.ru/',
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: 10000
    });
    console.log(`✓ Direct: status=${res.status}, userType=${res.headers['x-ap-user-type']}, catalogs=${res.data?.data?.catalogs?.length || 0}`);
  } catch (err) {
    console.log(`✗ Direct: ${err.message}`);
  }

  // 5. Test first 5 proxies
  console.log('\n--- 5. PROXY CONNECTIVITY & SESSION TESTS (first 5) ---');
  const testCount = Math.min(5, allProxies.length);
  for (let i = 0; i < testCount; i++) {
    const p = allProxies[i];
    const ip = p.host;
    const port = p.port;
    const user = p.auth.username;
    const pass = p.auth.password;
    
    console.log(`\n  Proxy ${i+1}: ${ip}:${port}`);
    
    // Test raw connectivity (no cookies)
    const rawResult = await testProxyConnectivity(ip, port, user, pass);
    if (rawResult.error) {
      console.log(`    Raw (no cookies): ✗ ${rawResult.error}`);
    } else {
      console.log(`    Raw (no cookies): ✓ status=${rawResult.status}, userType=${rawResult.userType}, catalogs=${rawResult.catalogs}`);
    }
    
    // Test with cached cookies
    const cachedCookie = cachedData.proxySessions[ip];
    if (cachedCookie) {
      const cookieResult = await testProxyWithCookies(ip, port, user, pass, cachedCookie);
      if (cookieResult.error) {
        console.log(`    With cookies:     ✗ ${cookieResult.error}`);
      } else {
        console.log(`    With cookies:     ✓ status=${cookieResult.status}, userType=${cookieResult.userType}, catalogs=${cookieResult.catalogs}`);
      }
    } else {
      console.log(`    With cookies:     - No cached cookies available`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
  }

  // 6. Test cookie sharing
  console.log('\n--- 6. COOKIE SHARING TEST ---');
  if (allProxies.length > 0 && cachedData.directCookie) {
    const p = allProxies[0];
    const result = await testProxyWithCookies(p.host, p.port, p.auth.username, p.auth.password, cachedData.directCookie);
    if (result.error) {
      console.log(`  ✗ ${result.error}`);
    } else {
      console.log(`  Direct cookie via proxy ${p.host}: userType=${result.userType}, catalogs=${result.catalogs}`);
      if (result.userType === 'user') {
        console.log('  → Cookie sharing WORKS across IPs.');
      } else {
        console.log('  → Cookie sharing BROKEN. Session is IP-bound.');
      }
    }
  }

  console.log('\n========================================');
  console.log('   DIAGNOSTICS COMPLETE');
  console.log('========================================');
}

main().catch(err => console.error('FATAL:', err));
