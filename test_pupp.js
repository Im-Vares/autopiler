const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

function getChromiumPath() {
  const os = require('os');
  const platform = os.platform();
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  }
  return 'google-chrome';
}

(async () => {
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
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    console.log("Navigating to https://autopiter.ru/goods/JRAT5015/aisin/id184556101...");
    await page.goto('https://autopiter.ru/goods/JRAT5015/aisin/id184556101', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Wait 5s for page to settle
    await new Promise(r => setTimeout(r, 5000));
    
    console.log("Fetching appraise data from page evaluate...");
    const appraiseResult = await page.evaluate(async () => {
      const response = await fetch('https://autopiter.ru/api/api/appraise?id=184556101&meta[frontendType]=1&meta[renderType]=1&meta[routeId]=APPRAISE_PRODUCT');
      return response.json();
    });
    
    fs.writeFileSync('appraise_response.json', JSON.stringify(appraiseResult, null, 2));
    console.log("Raw appraise response saved to appraise_response.json");
    
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await browser.close();
  }
})();
