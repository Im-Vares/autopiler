const axios = require('axios');
const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;

async function main() {
  const url = 'https://autopiter.ru/api/graphql';
  
  const proxy = {
    host: '146.19.39.75',
    port: 1080,
    username: 'mix427NUS9SZT',
    password: 'L4exSvPd'
  };

  const socksUrl = `socks5h://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  const agent = new SocksProxyAgent(socksUrl);

  const query = `
    query IntrospectionQuery {
      __schema {
        queryType {
          name
          fields {
            name
          }
        }
      }
    }
  `;

  try {
    console.log(`Sending introspection query to Autopiter GraphQL via proxy ${proxy.host}:${proxy.port}...`);
    const res = await axios.post(url, { query }, {
      httpAgent: agent,
      httpsAgent: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    if (res.data && res.data.data && res.data.data.__schema) {
      console.log('Success! Available queries:');
      const fields = res.data.data.__schema.queryType.fields;
      for (const field of fields) {
        console.log(`- Query: ${field.name}`);
      }
    } else {
      console.log('Response did not contain schema data:', JSON.stringify(res.data).substring(0, 1000));
    }
  } catch (err) {
    console.error('Introspection failed:', err.message);
    if (err.response) {
      console.error('Response status:', err.response.status);
      console.error('Response data:', JSON.stringify(err.response.data).substring(0, 1000));
    }
  }
}

main();
