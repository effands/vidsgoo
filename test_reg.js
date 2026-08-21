const http = require('http');

const postData = JSON.stringify({ id: 'ext_real_test', name: 'Chrome Agent' });

const req = http.request({
  hostname: '127.0.0.1',
  port: 7890,
  path: '/api/extension/register',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Register Response:', data));
});

req.write(postData);
req.end();
