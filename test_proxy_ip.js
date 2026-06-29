const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const fs = require('fs');

async function testProxyIp() {
  if (!fs.existsSync('proxies.txt')) {
    console.log("proxies.txt not found");
    return;
  }
  const content = fs.readFileSync('proxies.txt', 'utf-8').trim();
  const lines = content.split('\n');
  if (lines.length === 0) {
    console.log("No proxies in proxies.txt");
    return;
  }
  
  // Get first proxy line and parse
  let line = lines[0].trim().replace('@', ':');
  const s = line.split(':');
  if (s.length < 4) {
    console.log("Invalid proxy format, expected ip:port:user:pass. Got:", line);
    return;
  }
  
  const ip = s[0];
  const port = s[1];
  const user = s[2];
  const pass = s[3];
  
  // Let's test with socks5h
  const socks5hUrl = `socks5h://${user}:${pass}@${ip}:${port}`;
  // Let's test with socks5
  const socks5Url = `socks5://${user}:${pass}@${ip}:${port}`;
  
  console.log("Direct IP Check (no proxy)...");
  try {
    const directRes = await axios.get('https://httpbin.org/ip');
    console.log("Direct public IP is:", directRes.data.origin);
  } catch (e) {
    console.log("Direct check failed:", e.message);
  }

  console.log(`\nTesting with socks5hUrl: ${socks5hUrl}`);
  try {
    const agent = new SocksProxyAgent(socks5hUrl);
    const res = await axios.get('https://httpbin.org/ip', {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000
    });
    console.log("Proxy output IP (socks5h):", res.data.origin);
  } catch (e) {
    console.log("socks5h failed:", e.message);
  }

  console.log(`\nTesting with socks5Url: ${socks5Url}`);
  try {
    const agent = new SocksProxyAgent(socks5Url);
    const res = await axios.get('https://httpbin.org/ip', {
      httpAgent: agent,
      httpsAgent: agent,
      timeout: 10000
    });
    console.log("Proxy output IP (socks5):", res.data.origin);
  } catch (e) {
    console.log("socks5 failed:", e.message);
  }
}

testProxyIp();
