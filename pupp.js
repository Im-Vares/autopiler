const puppeteer = require('puppeteer-core');
const os = require('os');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SocksClient } = require('socks');
const DEFAULT_LOGINS_FILE = process.env.LOGINS_FILE
  ? path.resolve(process.env.LOGINS_FILE)
  : path.join(__dirname, 'logins.txt');

// ── Credential Helpers ──────────────────────────────────────────────

function getAllCredentials() {
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
    console.log(`[pupp.js] Failed to read ${DEFAULT_LOGINS_FILE}: ${err.message}`);
  }
  return [];
}

function getCredentialsByIndex(accountIndex) {
  const list = getAllCredentials();
  if (list.length === 0) return null;
  const idx = Math.max(0, Math.min(accountIndex, list.length - 1));
  return list[idx];
}

function getChromiumPath() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  } else {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return 'google-chrome';
  }
}

// ── Global concurrency = 1 with mutex per account ───────────────────

let globalLaunchBusy = false;
const globalLaunchQueue = [];
const accountMutexes = new Map(); // accountIndex → Promise chain

async function acquireGlobalLaunchSlot() {
  if (!globalLaunchBusy) {
    globalLaunchBusy = true;
    return;
  }
  return new Promise(resolve => {
    globalLaunchQueue.push(resolve);
  });
}

function releaseGlobalLaunchSlot() {
  if (globalLaunchQueue.length > 0) {
    const next = globalLaunchQueue.shift();
    next();
  } else {
    globalLaunchBusy = false;
  }
}

async function withAccountMutex(accountIndex, fn) {
  const key = String(accountIndex);
  const previous = accountMutexes.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  accountMutexes.set(key, previous.catch(() => {}).then(() => gate));

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (accountMutexes.get(key) === previous.catch(() => {}).then(() => gate)) {
      accountMutexes.delete(key);
    }
  }
}

function getProxyKey(proxy) {
  if (!proxy) return 'direct';
  return `${proxy.host}:${proxy.port}`;
}

// ── Login Flow ──────────────────────────────────────────────────────

async function performLogin(page, username, password, key) {
  console.log(`[pupp.js] Logging in for proxy ${key} with user ${username}...`);

  // Wait for "Вход" button to be rendered
  await page.waitForFunction(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    return spans.some(s => s.textContent && s.textContent.trim() === 'Вход') ||
           document.querySelector('span[class*="headerButton"], .Header__login');
  }, { timeout: 15000 });

  // Click "Вход" button
  const loginSpans = await page.$$('span');
  let loginBtn = null;
  for (const span of loginSpans) {
    const text = await page.evaluate(el => el.textContent.trim(), span);
    if (text === 'Вход') {
      loginBtn = span;
      break;
    }
  }
  if (loginBtn) {
    await loginBtn.click();
  } else {
    const fallbackBtn = await page.$('span[class*="headerButton"], .Header__login');
    if (fallbackBtn) {
      await fallbackBtn.click();
    } else {
      throw new Error('Login button (Вход) not found in page DOM');
    }
  }

  // Wait for login inputs
  const usernameInput = 'input[placeholder="Клиентский номер"]';
  const passwordInput = 'input[placeholder="Пароль"]';

  await page.waitForSelector(usernameInput, { timeout: 10000 });
  await page.waitForSelector(passwordInput, { timeout: 10000 });

  // Type credentials
  await page.$eval(usernameInput, el => el.value = '');
  await page.type(usernameInput, username, { delay: 50 });

  await page.$eval(passwordInput, el => el.value = '');
  await page.type(passwordInput, password, { delay: 50 });

  // Wait for "Войти" button
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.some(b => b.textContent && b.textContent.trim() === 'Войти') ||
           document.querySelector('button[class*="LoginForm__submitBtn"]');
  }, { timeout: 10000 });

  // Click submit
  const buttons = await page.$$('button');
  let submitBtn = null;
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent.trim(), btn);
    if (text === 'Войти') {
      submitBtn = btn;
      break;
    }
  }
  if (submitBtn) {
    await submitBtn.click();
  } else {
    const fallbackSubmit = await page.$('button[class*="LoginForm__submitBtn"]');
    if (fallbackSubmit) {
      await fallbackSubmit.click();
    } else {
      throw new Error('Submit button (Войти) not found in login form DOM');
    }
  }

  const loginStartedAt = Date.now();
  let loggedIn = false;
  while (Date.now() - loginStartedAt < 25000) {
    const cookies = await page.cookies().catch(() => []);
    if (cookies.some(cookie => cookie.name === 'sessionId' && cookie.value)) {
      loggedIn = true;
      break;
    }
    const domHasUser = await page.evaluate((uname) => {
      const spans = Array.from(document.querySelectorAll('span'));
      return spans.some(s => s.textContent && s.textContent.trim().includes(uname));
    }, username).catch(() => false);
    if (domHasUser) {
      loggedIn = true;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!loggedIn) {
    throw new Error('Login did not produce a sessionId cookie or authenticated UI state');
  }

  console.log(`[pupp.js] \x1b[32mAUTHENTICATION SUCCESSFUL\x1b[0m for user ${username} on proxy ${key}`);
  await new Promise(r => setTimeout(r, 2000));
}

function formatCookies(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ── Main entry point: getCookies ────────────────────────────────────
// Caller passes accountIndex explicitly. Browser is launched, login
// is performed, cookies are extracted, and browser + tunnel are
// closed immediately. No sessions are kept alive.

async function getCookies(proxy, force = false, customCredentials = null, accountIndex = 0) {
  const key = getProxyKey(proxy);

  return withAccountMutex(accountIndex, async () => {
    await acquireGlobalLaunchSlot();

    let browser = null;
    let tunnelServer = null;

    try {
      // Resolve credentials by accountIndex (not by proxy hash)
      const creds = customCredentials || getCredentialsByIndex(accountIndex);
      if (!creds) {
        throw new Error(`Missing or invalid credentials in ${DEFAULT_LOGINS_FILE}! Scraper requires authentication.`);
      }

      // Resolve fingerprint UA from prox.js if available
      let userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
      try {
        const prox = require('./prox.js');
        const fp = prox.getFingerprint(proxy);
        if (fp && fp['User-Agent']) {
          userAgent = fp['User-Agent'];
        }
      } catch (err) {
        // prox.js might not be loaded yet during bootstrap
      }

      // Build launch arguments
      const safeKey = key.replace(/[^a-zA-Z0-9]/g, '_');
      const userDataDir = path.join(__dirname, 'chrome-profiles', `chrome-user-data-${safeKey}`);
      let proxyArg = '';

      if (proxy && proxy.host) {
        const isSocks = proxy.protocol ? (proxy.protocol === 'socks5') : true;
        if (isSocks) {
          tunnelServer = await new Promise((resolve, reject) => {
            const server = http.createServer();

            server.on('connect', (req, clientSocket, head) => {
              let hostPort = req.url;
              let hostname = '';
              let destPort = 443;

              if (hostPort.includes(':')) {
                const parts = hostPort.split(':');
                hostname = parts[0];
                destPort = parseInt(parts[1], 10);
              } else {
                hostname = hostPort;
              }

              const options = {
                proxy: {
                  host: proxy.host,
                  port: parseInt(proxy.port, 10),
                  type: 5,
                  userId: proxy.auth.username,
                  password: proxy.auth.password
                },
                command: 'connect',
                destination: {
                  host: hostname,
                  port: destPort
                }
              };

              SocksClient.createConnection(options, (err, info) => {
                if (err) {
                  clientSocket.write('HTTP/1.1 500 Connection Error\r\n\r\n');
                  clientSocket.end();
                  return;
                }

                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                info.socket.pipe(clientSocket);
                clientSocket.pipe(info.socket);
                info.socket.on('error', () => clientSocket.end());
                clientSocket.on('error', () => info.socket.end());
              });
            });

            server.listen(0, '127.0.0.1', () => {
              resolve(server);
            });

            server.on('error', reject);
          });
          const localPort = tunnelServer.address().port;
          proxyArg = `--proxy-server=http://127.0.0.1:${localPort}`;
          console.log(`[pupp.js] Started local SOCKS5 tunnel on port ${localPort} for proxy ${key}`);
        } else {
          proxyArg = `--proxy-server=${proxy.host}:${proxy.port}`;
        }
      }

      const launchOptions = {
        executablePath: getChromiumPath(),
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          `--user-data-dir=${userDataDir}`,
          '--disable-crash-reporter',
          '--disable-features=Crashpad'
        ]
      };

      if (proxyArg) {
        launchOptions.args.push(proxyArg);
      }

      // Remove stale Chrome SingletonLock
      const lockPath = path.join(userDataDir, 'SingletonLock');
      try {
        fs.lstatSync(lockPath);
        fs.unlinkSync(lockPath);
      } catch (err) {
        // Ignore if file doesn't exist
      }

      browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();

      // Set authentication for HTTP proxies
      const isSocks = proxy && (proxy.protocol ? (proxy.protocol === 'socks5') : true);
      if (proxy && proxy.auth && proxy.auth.username && !isSocks) {
        await page.authenticate({
          username: proxy.auth.username,
          password: proxy.auth.password
        });
      }

      // Use stable fingerprint UA
      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1280, height: 800 });

      // Navigate to Autopiter
      await page.goto('https://autopiter.ru', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Check for challenge/block page — if detected, throw immediately
      // (no bypass attempts per spec)
      const isChallengePage = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return text.includes('Вы очень активный!') || text.includes('Я не робот!') ||
               text.includes('challenge') || text.includes('captcha');
      });

      if (isChallengePage) {
        throw new Error('Challenge/block page detected. Proxy and account need cooldown.');
      }

      // Clear cookies and storage for clean login
      const existingCookies = await page.cookies();
      for (const cookie of existingCookies) {
        await page.deleteCookie(cookie);
      }
      try {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      } catch (e) {}

      // Reload with clean state
      await page.goto('https://autopiter.ru', { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Check for challenge again after reload
      const isBlockedAfterReload = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return text.includes('Вы очень активный!') || text.includes('Я не робот!');
      });
      if (isBlockedAfterReload) {
        throw new Error('Challenge/block page detected after reload. Proxy and account need cooldown.');
      }

      // Perform login
      await performLogin(page, creds.username, creds.password, key);

      // Set guest city to Moscow (cityId: 28)
      try {
        await page.evaluate(() => {
          return fetch('https://autopiter.ru/api/api/cities/setguest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cityId: 28 })
          }).then(r => r.json());
        });
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        // ignore
      }

      // Extract cookies
      const finalCookies = await page.cookies();
      const cookieStr = formatCookies(finalCookies);

      // Close page explicitly
      await page.close().catch(() => {});

      return cookieStr;
    } finally {
      // Always close browser and tunnel immediately
      if (browser) {
        try {
          await browser.close();
        } catch (err) {
          // ignore
        }
      }
      if (tunnelServer) {
        try {
          tunnelServer.close();
          console.log(`[pupp.js] Closed local SOCKS5 tunnel for proxy ${key}`);
        } catch (err) {
          // ignore
        }
      }
      releaseGlobalLaunchSlot();
    }
  });
}

// ── Cleanup stubs (backward-compatible exports) ─────────────────────
// No sessions are kept alive anymore, so these are no-ops.

async function closeSession(key) {
  // No-op: browser is closed immediately after getCookies
}

async function closeAllSessions() {
  // No-op: no persistent browser sessions
  console.log(`[pupp.js] closeAllSessions() called — no persistent sessions to close.`);
}

module.exports = { getCookies, closeSession, closeAllSessions };
