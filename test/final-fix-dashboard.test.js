const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function dashboardScript() {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.listeners = new Map();
    this.children = [];
    this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.dataset = {};
    this.htmlWrites = [];
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.textContent = '';
    this.value = '';
    this.videoNodes = [];
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  focus() {}
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(item => item !== child); }
  querySelectorAll(selector) {
    return selector === 'video[data-video-key]' ? this.videoNodes : [];
  }
  set innerHTML(value) {
    this._innerHTML = value;
    this.htmlWrites.push(value);
    if (this.id === 'galleryGrid' && value.includes('<video')) {
      const keys = [...value.matchAll(/data-video-key="([^"]+)"/g)].map(match => match[1]);
      this.videoNodes = keys.map(key => ({
        dataset: { videoKey: key },
        currentTime: 0,
        paused: true,
        playCalls: 0,
        play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
      }));
    }
  }
  get innerHTML() { return this._innerHTML || ''; }
}

function createDashboardHarness(initial = {}) {
  const elements = new Map();
  const requests = [];
  const state = {
    chromes: initial.chromes || [],
    status: initial.status || { queue: [], logs: [] },
    gallery: initial.gallery || []
  };
  const document = {
    listeners: new Map(),
    documentElement: { getAttribute: () => 'dark', setAttribute() {} },
    createElement() { return new FakeElement(); },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    }
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/chromes') return { ok: true, json: async () => state.chromes };
    if (url === '/api/status') return { ok: true, json: async () => state.status };
    if (url === '/api/gallery') return { ok: true, json: async () => state.gallery };
    if (url === '/api/delete-token') return { ok: true, json: async () => ({ token: 'delete-token-123' }) };
    return { ok: true, json: async () => ({ success: true }) };
  };
  const context = vm.createContext({
    alert() {},
    confirm: () => true,
    console,
    document,
    fetch,
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText() {} } },
    setInterval() {},
    setTimeout() {}
  });
  context.window = context;
  context.window.scrollTo = () => {};
  vm.runInContext(dashboardScript(), context);
  return { context, document, elements, requests, state };
}

async function flushAsyncWork() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('dashboard never inserts extension-derived agent, task, gallery, or log payloads as HTML', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const harness = createDashboardHarness({
    chromes: [{ id: 'ext_x', name: payload, port: payload, status: 'Online' }],
    status: {
      queue: [{ id: 'task_x', prompt: payload, ratio: payload, status: payload, createdAt: payload }],
      logs: [payload]
    },
    gallery: [{
      filename: payload,
      url: '/downloads/safe.mp4',
      sizeMB: '1.00',
      createdLabel: payload,
      source: 'server',
      sourceLabel: payload
    }]
  });
  await flushAsyncWork();

  const writes = [...harness.elements.values()].flatMap(element => element.htmlWrites);
  assert.equal(writes.some(write => write.includes(payload)), false);
});

test('dashboard keeps confirmations and sends its same-origin token to both gallery delete endpoints', async () => {
  const harness = createDashboardHarness();
  await flushAsyncWork();
  const galleryGrid = harness.document.getElementById('galleryGrid');
  const deleteOne = {
    dataset: { source: 'server', filename: encodeURIComponent('video.mp4') },
    closest(selector) { return selector === '.delete-video-btn' ? this : null; }
  };

  const deleteOneRequest = galleryGrid.listeners.get('click')({ target: deleteOne });
  harness.document.getElementById('confirmAccept').listeners.get('click')();
  await deleteOneRequest;
  const deleteAllRequest = harness.document.getElementById('clearGalleryBtn').listeners.get('click')();
  harness.document.getElementById('confirmAccept').listeners.get('click')();
  await deleteAllRequest;
  await flushAsyncWork();

  const deletes = harness.requests.filter(request => request.options.method === 'DELETE');
  assert.equal(deletes.length, 2);
  for (const request of deletes) {
    assert.equal(request.options.headers['X-Delete-Confirmation-Token'], 'delete-token-123');
  }
});

test('unchanged gallery polling does not replace video elements', async () => {
  const gallery = [{
    filename: 'video.mp4', url: '/downloads/video.mp4', sizeMB: '1.00', createdLabel: 'now', source: 'server', sourceLabel: 'Server'
  }];
  const harness = createDashboardHarness({ gallery });
  await flushAsyncWork();
  const grid = harness.document.getElementById('galleryGrid');
  const writesBefore = grid.htmlWrites.length;

  await vm.runInContext('fetchGallery()', harness.context);

  assert.equal(grid.htmlWrites.length, writesBefore);
});

test('a necessary gallery rerender restores currentTime and playback state', async () => {
  const first = { filename: 'one.mp4', url: '/downloads/one.mp4', sizeMB: '1.00', createdLabel: 'now', source: 'server', sourceLabel: 'Server' };
  const harness = createDashboardHarness({ gallery: [first] });
  await flushAsyncWork();
  const grid = harness.document.getElementById('galleryGrid');
  assert.equal(grid.videoNodes.length, 1);
  grid.videoNodes[0].currentTime = 7.5;
  grid.videoNodes[0].paused = false;
  const playingKey = grid.videoNodes[0].dataset.videoKey;
  harness.state.gallery = [first, {
    filename: 'two.mp4', url: '/downloads/two.mp4', sizeMB: '2.00', createdLabel: 'later', source: 'server', sourceLabel: 'Server'
  }];

  await vm.runInContext('fetchGallery()', harness.context);

  const restored = grid.videoNodes.find(video => video.dataset.videoKey === playingKey);
  assert.ok(restored);
  assert.equal(restored.currentTime, 7.5);
  assert.equal(restored.playCalls, 1);
});
