const fs = require('fs');
const http = require('http');

const promptText = fs.readFileSync('prompt_test.txt', 'utf8');

const postData = JSON.stringify({
  prompts: promptText,
  ratio: '16:9',
  targetChrome: 'auto'
});

const req = http.request({
  hostname: '127.0.0.1',
  port: 7890,
  path: '/api/queue/add',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Response:', data));
});

req.write(postData);
req.end();
