const fs = require('fs');
const path = require('path');
const axios = require('axios');

async function testAppraise() {
  try {
    // 1. Read cookies from direct connection profile
    const safeKey = 'direct';
    const profilePath = path.join(__dirname, 'chrome-profiles', `chrome-user-data-${safeKey}`, 'Default', 'Network', 'Cookies');
    
    // As a simpler fallback, let's just launch Puppeteer in headless mode, 
    // navigate to Autopiter, and use page.evaluate to fetch and print the raw JSON response.
    // To ensure Chromium starts without sandbox blockages, we can use the same profile directory.
    const puppeteer = require('puppeteer-core');
    function getChromiumPath() {
      const os = require('os');
      const platform = os.platform();
      if (platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      }
      return 'google-chrome';
    }

    const userDataDir = path.join(__dirname, 'chrome-profiles', 'chrome-user-data-direct');
    const browser = await puppeteer.launch({
      executablePath: getChromiumPath(),
      headless: 'new',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        `--user-data-dir=${userDataDir}`
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log("Navigating to Autopiter...");
    await page.goto('https://autopiter.ru', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Check if logged in
    const bodyText = await page.evaluate(() => document.body.innerText);
    const isLoggedIn = bodyText.includes('1875855') || bodyText.includes('1875889');
    console.log("Is logged in in Puppeteer:", isLoggedIn);

    console.log("Fetching appraise JSON...");
    const data = await page.evaluate(async () => {
      const response = await fetch('https://autopiter.ru/api/api/appraise?id=184556101&meta[frontendType]=1&meta[renderType]=1&meta[routeId]=APPRAISE_PRODUCT');
      return response.json();
    });

    console.log("Raw Response:");
    console.log(JSON.stringify(data, null, 2));

    await browser.close();
  } catch (err) {
    console.error("Error:", err);
  }
}

testAppraise();
