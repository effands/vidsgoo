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

test('trustedKey dispatches Enter to the focused Google Vids ratio control', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) { commands.push({ method, params }); }
    }
  });

  await invoke(harness.context, "trustedKey(12, 'Enter')");
  assert.deepEqual(commands.map(command => command.params.type), ['rawKeyDown', 'keyUp']);
  assert.ok(commands.every(command => command.method === 'Input.dispatchKeyEvent'));
});

test('hardReloadAndRetry reports the same task before bypass-cache reload', async () => {
  const events = [];
  const harness = loadBackground({
    tabs: {
      async get() { return { id: 12, url: 'https://docs.google.com/videos/create' }; },
      async reload(_tabId, options) { events.push(['reload', options]); }
    }
  });

  await invoke(harness.context, "hardReloadAndRetry(12, 'task_reload', 'composer tidak bersih')");
  assert.equal(harness.requests.filter(request => request.url.endsWith('/api/extension/fail-task')).length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'reload');
  assert.equal(events[0][1].bypassCache, true);
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

function loadContentSelectorFunctions(elements) {
  const document = {
    querySelector() { return null; },
    querySelectorAll() { return elements; }
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
      sendMessage(_message, callback) { if (callback) callback({}); }
    }
  };
  const exposedSource = contentSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__selectors = { findBahanOrAddButton, findCreateModeButton: typeof findCreateModeButton === "function" ? findCreateModeButton : undefined, findCreateButton, findAiPromptBox }; })();'
  );
  const context = vm.createContext({ chrome, console, document, setInterval() {} });
  vm.runInContext(exposedSource, context);
  return context.__selectors;
}

test('affiliate upload selects the exact Bahan control instead of a broad container or Avatar', () => {
  const broadContainer = contentElement({ text: 'Buat Avatar Bahan' });
  broadContainer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 700 });
  const avatarButton = contentElement({ text: 'Avatar' });
  const bahanButton = contentElement({ text: 'Bahan' });
  const selectors = loadContentSelectorFunctions([broadContainer, avatarButton, bahanButton]);

  assert.equal(selectors.findBahanOrAddButton(), bahanButton);
});

test('affiliate upload selects the exact Buat tab before adding Bahan', () => {
  const editTab = contentElement({ text: 'Edit' });
  const buatTab = contentElement({ text: 'Buat' });
  const selectors = loadContentSelectorFunctions([editTab, buatTab]);

  assert.equal(selectors.findCreateModeButton(), buatTab);
});

test('generate selector never mistakes an empty circular Drive button for Buat', () => {
  const moveButton = contentElement({ ariaLabel: 'Pindahkan' });
  moveButton.getBoundingClientRect = () => ({ left: 10, top: 10, width: 40, height: 40 });
  const generateButton = contentElement({ ariaLabel: 'Buat' });
  generateButton.getBoundingClientRect = () => ({ left: 500, top: 500, width: 48, height: 48 });
  const selectors = loadContentSelectorFunctions([moveButton, generateButton]);

  assert.equal(selectors.findCreateButton(), generateButton);
});

test('prompt selector ignores canvas textboxes outside the Video AI panel', () => {
  const canvasBox = contentElement({ ariaLabel: 'Deskripsikan video Anda' });
  canvasBox.closest = () => null;
  const aiBox = contentElement({ ariaLabel: 'Deskripsikan video Anda' });
  aiBox.closest = () => ({ textContent: 'Buat' });
  const selectors = loadContentSelectorFunctions([canvasBox, aiBox]);
  assert.equal(selectors.findAiPromptBox(), aiBox);
});

async function runContentAutomation({ images = undefined, ratio = '16:9', mode = 'affiliate', ignoredVideoAiClicks = 0, ignoredRenderClicks = 0 } = {}) {
  let messageListener;
  let panelOpen = false;
  let composerExpanded = false;
  let uploadedReferenceCount = 0;
  let generated = false;
  let renderRequests = 0;
  let ratioMenuOpen = false;
  let selectedRatio = '16:9';
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
  promptBox.closest = () => ({ textContent: 'Buat' });
  let videoAiClickCount = 0;
  const videoAiButton = contentElement({ text: 'Video AI', onClick() {
    videoAiClickCount += 1;
    if (videoAiClickCount > ignoredVideoAiClicks) panelOpen = true;
  } });
  const createButton = contentElement({ text: 'Buat', onClick() {
    renderRequests += 1;
    if (renderRequests > ignoredRenderClicks) generated = true;
  } });
  const expandButton = contentElement({ ariaLabel: 'Luaskan', onClick() { composerExpanded = true; } });
  const bahanButton = contentElement({ text: 'Bahan' });
  const ratioButton = contentElement({ text: 'Lanskap' });
  const landscapeOption = contentElement({ text: 'Lanskap 16:9' });
  const portraitOption = contentElement({ text: 'Potret 9:16' });
  const referenceTags = [contentElement({ text: 'Gambar1' }), contentElement({ text: 'Gambar2' }), contentElement({ text: 'Gambar3' })];
  const fileInput = contentElement();
  fileInput.accept = 'image/png';
  fileInput.dispatchEvent = event => {
    if (event?.type === 'change') uploadedReferenceCount += fileInput.files?.length || 0;
  };
  const document = {
    execCommand() { return true; },
    createRange() { return { selectNodeContents() {} }; },
    querySelector(selector) {
      if (selector.startsWith('[role="textbox"]')) return panelOpen ? promptBox : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('[role="textbox"]')) return panelOpen ? [promptBox] : [];
      if (selector === 'input[type="file"]') return composerExpanded ? [fileInput] : [];
      if (selector === 'video' || selector === 'video[src]') {
        if (!panelOpen) return [];
        return generated ? [oldVideo, freshVideo] : [oldVideo];
      }
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        if (!panelOpen) return [videoAiButton];
        ratioButton.textContent = selectedRatio === '9:16' ? 'Potret' : 'Lanskap';
        return [createButton, expandButton, ...(composerExpanded ? [bahanButton, ratioButton] : []), ...(ratioMenuOpen ? [landscapeOption, portraitOption] : []), ...referenceTags.slice(0, uploadedReferenceCount)];
      }
      if (uploadedReferenceCount && (selector.includes('[aria-label]') || selector.includes('span'))) return referenceTags.slice(0, uploadedReferenceCount);
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
          if (message.stage?.startsWith('Membuka Panel Video AI')) videoAiButton.click();
          if (message.stage === 'Membuka Form Buat') expandButton.click();
          if (message.stage === 'Submitting') expandButton.click();
          if (message.stage === 'Membuka Pilihan Rasio') ratioMenuOpen = true;
          if (message.stage === 'Memilih Rasio 9:16') { selectedRatio = '9:16'; ratioMenuOpen = false; }
          if (message.stage === 'Memilih Rasio 16:9') { selectedRatio = '16:9'; ratioMenuOpen = false; }
          if (message.stage === 'Rendering') createButton.click();
          return Promise.resolve({ success: true });
        }
        if (message.type === 'DOWNLOAD_VIDEO_FILE') return Promise.resolve({ success: true, downloadId: 7 });
        if (callback) callback({ status: 'ack' });
        return undefined;
      }
    }
  };
  let timerId = 0;
  let fakeNow = 0;
  const activeTimers = new Map();
  const window = {
    getSelection() { return { removeAllRanges() {}, addRange() {} }; }
  };
  class FakeEvent { constructor(type) { this.type = type; } }
  const context = vm.createContext({
    chrome,
    console,
    document,
    window,
    InputEvent: FakeEvent,
    Event: FakeEvent,
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    DataTransfer: class DataTransfer { constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; } },
    File: class File { constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options?.type; } },
    atob,
    Date: { now() { fakeNow += 1000; return fakeNow; } },
    setTimeout,
    setInterval(callback) {
      const id = ++timerId;
      if (id === 1) {
        setImmediate(callback);
        return id;
      }
      activeTimers.set(id, true);
      const tick = () => {
        if (!activeTimers.get(id)) return;
        callback();
        if (activeTimers.get(id)) setImmediate(tick);
      };
      setImmediate(tick);
      return id;
    },
    clearInterval(id) { activeTimers.set(id, false); }
  });
  vm.runInContext(contentSource, context);
  const result = await new Promise(resolve => {
    assert.equal(messageListener({ type: 'EXECUTE_VIDS_AUTOMATION', prompt: 'Prompt', ratio, taskId: 'task_content', images, mode }, {}, resolve), true);
  });
  return { result, sent, renderRequests, videoAiClickCount };
}

test('affiliate image automation expands the Buat composer before direct upload', async () => {
  const { result, sent } = await runContentAutomation({
    images: [{ name: 'produk.png', tag: '@Gambar1', dataUrl: 'data:image/png;base64,AA==' }]
  });
  assert.equal(result.success, true);
  const stages = sent.filter(message => message.type === 'TRUSTED_CLICK').map(message => message.stage);
  assert.ok(stages.includes('Membuka Form Buat'));
  assert.equal(stages.includes('Klik Tambah Gambar'), false);
});

test('Video AI is clicked again when the first click does not open the prompt', async () => {
  const { result, videoAiClickCount } = await runContentAutomation({ ignoredVideoAiClicks: 1 });
  assert.equal(result.success, true);
  assert.equal(videoAiClickCount, 2);
});

test('Video AI opens with one direct click when the control responds normally', async () => {
  const { result, videoAiClickCount } = await runContentAutomation();
  assert.equal(result.success, true);
  assert.equal(videoAiClickCount, 1);
});

test('affiliate image automation uploads multiple images sequentially without opening native file picker', async () => {
  const { result, sent } = await runContentAutomation({
    images: [
      { name: 'produk-1.png', tag: '@Gambar1', dataUrl: 'data:image/png;base64,AA==' },
      { name: 'produk-2.png', tag: '@Gambar2', dataUrl: 'data:image/png;base64,AA==' }
    ]
  });
  assert.equal(result.success, true);
  const bahanClicks = sent.filter(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Klik Tambah Gambar');
  assert.equal(bahanClicks.length, 0, 'Bahan must not be clicked because it opens the native file picker');
});

test('affiliate automation selects and confirms portrait ratio before Rendering', async () => {
  const { result, sent } = await runContentAutomation({ ratio: '9:16' });
  assert.equal(result.success, true);
  const stages = sent.filter(message => message.type === 'TRUSTED_CLICK').map(message => message.stage);
  assert.ok(stages.indexOf('Memilih Rasio 9:16') > stages.indexOf('Membuka Pilihan Rasio'));
  assert.equal(result.success, true);
});

test('affiliate ratio uses trusted keyboard activation instead of coordinate clicks', () => {
  assert.match(contentSource, /trustedKeyPress\(active, taskId, 'Membuka Pilihan Rasio'\)/);
  assert.match(contentSource, /trustedKeyPress\(option, taskId, 'Memilih Rasio '/);
  assert.match(contentSource, /\[role="menuitemradio"\]/);
});

test('ordinary video mode skips affiliate Bahan but confirms ratio before Rendering', async () => {
  const { result, sent, renderRequests } = await runContentAutomation({ mode: null, ratio: '9:16' });
  assert.equal(result.success, true);
  const stages = sent.filter(message => message.type === 'TRUSTED_CLICK').map(message => message.stage);
  assert.equal(stages.includes('Pilih Mode Buat'), false);
  assert.equal(stages.includes('Membuka Form Buat'), false);
  assert.ok(stages.indexOf('Memilih Rasio 9:16') > stages.indexOf('Submitting'));
  assert.equal(renderRequests, 1, 'ordinary mode must not double-click after the layout changes');
});

test('a responsive generate button is clicked exactly once', async () => {
  const { result, sent, renderRequests } = await runContentAutomation();
  assert.equal(result.success, true);
  const generateClick = sent.find(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Rendering');
  assert.equal(generateClick, undefined, 'trusted fallback must not run when the direct click starts rendering');
  assert.equal(renderRequests, 1, 'one task must trigger exactly one render');
});

test('generate is clicked again when Google Vids does not show render progress', async () => {
  const { result, renderRequests } = await runContentAutomation({ ignoredRenderClicks: 1 });
  assert.equal(result.success, true);
  assert.equal(renderRequests, 2);
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
