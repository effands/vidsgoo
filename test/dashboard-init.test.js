const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function dashboardScript() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return scripts.map(match => match[1]).join('\n');
}

function fakeElement() {
  return {
    addEventListener() {},
    appendChild() {},
    querySelectorAll() { return []; },
    className: '',
    innerHTML: '',
    scrollHeight: 0,
    scrollTop: 0,
    textContent: '',
    value: ''
  };
}

test('dashboard tetap melakukan fetch awal saat addPortBtn tidak tersedia', async () => {
  const fetchCalls = [];
  const elements = new Map();
  const document = {
    documentElement: { getAttribute: () => 'dark', setAttribute() {} },
    createElement: fakeElement,
    getElementById(id) {
      if (id === 'addPortBtn' || id === 'newPort') return null;
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    }
  };

  const context = {
    alert() {},
    confirm: () => false,
    console,
    document,
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === '/api/chromes') return { json: async () => [] };
      if (url === '/api/status') return { json: async () => ({ queue: [], logs: [] }) };
      if (url === '/api/gallery') return { json: async () => [] };
      return { json: async () => ({}) };
    },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() {}
  };
  context.window = context;

  assert.doesNotThrow(() => vm.runInNewContext(dashboardScript(), context));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fetchCalls.slice(0, 3), ['/api/chromes', '/api/status', '/api/gallery']);
});

test('manifest memberikan permission storage yang digunakan background worker', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('storage'));
});
