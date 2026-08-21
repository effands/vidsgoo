const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');

function loadBackground({ downloads = {}, tabs = {}, debuggerApi = {} } = {}) {
  const requests = [];
  const tabEvents = [];
  let messageListener;
  let downloadListener;
  const chrome = {
    storage: { local: { get(_keys, callback) { callback({ ext_id: 'ext_test' }); }, set() {} } },
    runtime: { onMessage: { addListener(listener) { messageListener = listener; } } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    downloads: {
      async download() { return 7; },
      async search() { return [{ id: 7, filename: 'C:\\Downloads\\Google_Vids\\video.mp4', totalBytes: 1024, state: 'complete' }]; },
      onChanged: {
        addListener(listener) { downloadListener = listener; },
        removeListener() {}
      },
      ...downloads
    },
    tabs: {
      async query() { tabEvents.push('query'); return []; },
      async create() { tabEvents.push('create'); return { id: 12, url: 'https://docs.google.com/videos/create' }; },
      async update() { tabEvents.push('update'); },
      async sendMessage() { tabEvents.push('message'); return { success: true }; },
      async get() { return { id: 12, url: 'https://docs.google.com/videos/create' }; },
      ...tabs
    },
    scripting: { async executeScript() {} },
    debugger: {
      async attach() {},
      async sendCommand() {},
      async detach() {},
      ...debuggerApi
    }
  };
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, options, body });
    return {
      ok: true,
      status: 200,
      async json() {
        return url.includes('/api/extension/get-task') ? { hasTask: false } : { success: true };
      }
    };
  };
  const context = vm.createContext({
    chrome,
    fetch,
    console,
    encodeURIComponent,
    setImmediate,
    setInterval() {},
    setTimeout(callback, ms) {
      if (ms >= 300000) return { callback };
      return setTimeout(callback, ms);
    },
    clearTimeout() {}
  });
  vm.runInContext(backgroundSource, context);
  return { chrome, context, requests, tabEvents, getMessageListener: () => messageListener, getDownloadListener: () => downloadListener };
}

async function invoke(context, expression) {
  return vm.runInContext(expression, context);
}

test('background rejects missing, non-positive, and non-complete download records', async () => {
  const cases = [
    { name: 'missing', item: null },
    { name: 'zero bytes', item: { id: 7, filename: 'video.mp4', totalBytes: 0, state: 'complete' } },
    { name: 'non-complete', item: { id: 7, filename: 'video.mp4', totalBytes: 1024, state: 'in_progress' } }
  ];

  for (const scenario of cases) {
    let listener;
    const harness = loadBackground({
      downloads: {
        async search() { return scenario.item ? [scenario.item] : []; },
        onChanged: {
          addListener(nextListener) {
            listener = nextListener;
            setImmediate(() => listener({ id: 7, state: { current: 'complete' } }));
          },
          removeListener() {}
        }
      }
    });

    const result = await invoke(harness.context,
      "downloadGeneratedVideo({ videoUrl: 'https://contribution-rt.usercontent.google.com/video.mp4', taskId: 'task_" + scenario.name.replace(/\W/g, '_') + "' })"
    );
    const terminalRequests = harness.requests.filter(request => /\/(complete-task|fail-task)$/.test(request.url));
    assert.equal(result.success, false, `${scenario.name} must fail`);
    assert.equal(terminalRequests.filter(request => request.url.endsWith('/complete-task')).length, 0);
    assert.equal(terminalRequests.filter(request => request.url.endsWith('/fail-task')).length, 1);
  }
});

test('waitForDownload observes an already-complete fast download immediately', async () => {
  const harness = loadBackground({
    downloads: {
      async search() {
        return [{ id: 7, filename: 'video.mp4', totalBytes: 1024, state: 'complete' }];
      },
      onChanged: { addListener() {}, removeListener() {} }
    }
  });

  const outcome = await Promise.race([
    invoke(harness.context, 'waitForDownload(7)').then(() => 'complete'),
    new Promise(resolve => setTimeout(() => resolve('missed'), 50))
  ]);
  assert.equal(outcome, 'complete');
});

test('background reports one failure for duplicate signals from the same task attempt', async () => {
  const harness = loadBackground();
  await Promise.all([
    invoke(harness.context, "reportFailure('task_duplicate', 'Download video gagal.')"),
    invoke(harness.context, "reportFailure('task_duplicate', 'Background gagal mengunduh video.')")
  ]);

  assert.equal(harness.requests.filter(request => request.url.endsWith('/api/extension/fail-task')).length, 1);
});

test('background rejects a non-Google-Vids task URL before touching tabs', async () => {
  const harness = loadBackground();
  await invoke(harness.context,
    "executeTaskOnTab({ id: 'task_bad_url', url: 'https://example.com/phishing', prompt: 'x', ratio: '16:9' })"
  );

  assert.deepEqual(harness.tabEvents, []);
  assert.equal(harness.requests.filter(request => request.url.endsWith('/api/extension/fail-task')).length, 1);
});

test('trustedClick rechecks the tab URL after attach and always detaches on mismatch', async () => {
  const events = [];
  let getCalls = 0;
  const harness = loadBackground({
    tabs: {
      async get() {
        getCalls++;
        return { id: 12, url: getCalls === 1 ? 'https://docs.google.com/videos/create' : 'https://example.com/' };
      }
    },
    debuggerApi: {
      async attach() { events.push('attach'); },
      async sendCommand() { events.push('dispatch'); },
      async detach() { events.push('detach'); }
    }
  });

  await assert.rejects(() => invoke(harness.context, 'trustedClick(12, 10, 20)'), /Google Vids/);
  assert.deepEqual(events, ['attach', 'detach']);
});

function contentElement({ text = '', ariaLabel = null, onClick = null } = {}) {
  return {
    disabled: false,
    offsetParent: {},
    textContent: text,
    click() { if (onClick) onClick(); },
    focus() {},
    dispatchEvent() {},
    getAttribute(name) {
      if (name === 'aria-label') return ariaLabel;
      if (name === 'role') return null;
      if (name === 'aria-pressed') return 'true';
      return null;
    },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 40 }; }
  };
}

async function runContentAutomation() {
  let messageListener;
  let panelOpen = false;
  let generated = false;
  const sent = [];
  const oldVideo = {
    src: 'https://contribution-rt.usercontent.google.com/old-src.mp4',
    currentSrc: 'https://contribution-rt.usercontent.google.com/old-current.mp4',
    querySelectorAll() { return [{ src: 'https://contribution-rt.usercontent.google.com/old-source.mp4' }]; }
  };
  const freshVideo = {
    src: '',
    currentSrc: '',
    querySelectorAll() { return [{ src: 'https://contribution-rt.usercontent.google.com/fresh-source.mp4' }]; }
  };
  const promptBox = contentElement({ ariaLabel: 'Deskripsikan video Anda' });
  const videoAiButton = contentElement({ text: 'Video AI', onClick() { panelOpen = true; } });
  const createButton = contentElement({ text: 'Buat' });
  const document = {
    execCommand() {},
    querySelector(selector) {
      if (selector.startsWith('[role="textbox"]')) return panelOpen ? promptBox : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return panelOpen ? [createButton] : [videoAiButton];
      if (selector === 'button') return panelOpen ? [createButton] : [];
      if (selector === 'video' || selector === 'video[src]') {
        if (!panelOpen) return [];
        return generated ? [oldVideo, freshVideo] : [oldVideo];
      }
      return [];
    }
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === 'TRUSTED_CLICK') {
          if (message.stage === 'Rendering') generated = true;
          return Promise.resolve({ success: true });
        }
        if (message.type === 'DOWNLOAD_VIDEO_FILE') return Promise.resolve({ success: true, downloadId: 7 });
        if (callback) callback({ status: 'ack' });
        return undefined;
      }
    }
  };
  let timerId = 0;
  const context = vm.createContext({
    chrome,
    console,
    document,
    InputEvent: class InputEvent {},
    setInterval(callback) { const id = ++timerId; setImmediate(callback); return id; },
    clearInterval() {}
  });
  vm.runInContext(contentSource, context);
  const result = await new Promise(resolve => {
    assert.equal(messageListener({ type: 'EXECUTE_VIDS_AUTOMATION', prompt: 'Prompt', ratio: '16:9', taskId: 'task_content' }, {}, resolve), true);
  });
  return { result, sent };
}

test('the trusted generate click reports Rendering', async () => {
  const { result, sent } = await runContentAutomation();
  assert.equal(result.success, true);
  const generateClick = sent.find(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Rendering');
  assert.ok(generateClick, 'generate click must produce the Rendering stage');
});

test('fresh-result baseline is captured after the panel opens and covers nested source URLs', async () => {
  const { result, sent } = await runContentAutomation();
  assert.equal(result.success, true);
  const download = sent.find(message => message.type === 'DOWNLOAD_VIDEO_FILE');
  assert.equal(download.videoUrl, 'https://contribution-rt.usercontent.google.com/fresh-source.mp4');
});

test('content scripts only match Google Vids pages', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts.flatMap(script => script.matches), ['https://docs.google.com/videos/*']);
});
