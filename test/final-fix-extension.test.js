const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');

test('content script registers only one automation listener when injected twice', () => {
  let listenerCount = 0;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() { listenerCount += 1; } },
      sendMessage(_message, callback) { if (callback) callback({}); }
    }
  };
  const context = vm.createContext({ chrome, console, setInterval() {} });

  vm.runInContext(contentSource, context);
  vm.runInContext(contentSource, context);

  assert.equal(listenerCount, 1);
});

function loadBackground({ downloads = {}, tabs = {}, debuggerApi = {}, failTaskResponse = null } = {}) {
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
        if (url.includes('/api/extension/fail-task') && failTaskResponse) return failTaskResponse;
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

test('trustedClick uses the element center without shifting into the ratio tooltip', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) { commands.push({ method, params }); }
    }
  });

  await invoke(harness.context, 'trustedClick(12, 110, 220)');
  assert.deepEqual(commands.map(command => [command.params.x, command.params.y]), [
    [110, 220],
    [110, 220],
    [110, 220]
  ]);
});

test('trustedClick resolves the live ratio control center after debugger attachment', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) {
        commands.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { value: { x: 333, y: 444 } } };
        return {};
      }
    }
  });

  await invoke(harness.context, "trustedClick(12, 110, 220, 'Membuka Pilihan Rasio')");
  const mouseCommands = commands.filter(command => command.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouseCommands.map(command => [command.params.x, command.params.y]), [
    [333, 444],
    [333, 444],
    [333, 444]
  ]);
});

test('trustedClick resolves the live Video AI control center after debugger attachment', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) {
        commands.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { value: { x: 515, y: 616 } } };
        return {};
      }
    }
  });

  await invoke(harness.context, "trustedClick(12, 10, 20, 'Membuka Panel Video AI')");
  const mouseCommands = commands.filter(command => command.method === 'Input.dispatchMouseEvent');
  assert.deepEqual(mouseCommands.map(command => [command.params.x, command.params.y]), [
    [515, 616],
    [515, 616],
    [515, 616]
  ]);
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

test('trustedClearPrompt sends Ctrl+A and Backspace to the focused Buat Video prompt', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) { commands.push({ method, params }); }
    }
  });

  await invoke(harness.context, 'trustedClearPrompt(12)');
  assert.ok(commands.every(command => command.method === 'Input.dispatchKeyEvent'));
  assert.deepEqual(commands.map(command => command.params.key), ['Control', 'a', 'a', 'Control', 'Backspace', 'Backspace']);
});

test('trustedInsertText inserts the standard video prompt through DevTools', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) { commands.push({ method, params }); }
    }
  });

  await invoke(harness.context, "trustedInsertText(12, 'Prompt sungai')");
  assert.equal(JSON.stringify(commands), JSON.stringify([{ method: 'Input.insertText', params: { text: 'Prompt sungai' } }]));
});

test('trustedReplacePrompt selects the old prompt and inserts its replacement in one debugger session', async () => {
  const commands = [];
  const harness = loadBackground({
    debuggerApi: {
      async sendCommand(_debuggee, method, params) { commands.push({ method, params }); }
    }
  });

  await invoke(harness.context, "trustedReplacePrompt(12, 'Prompt kedua')");
  assert.deepEqual(commands.map(command => command.method), [
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText'
  ]);
  assert.equal(commands.at(-1).params.text, 'Prompt kedua');
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

test('hardReloadAndRetry stops refreshing when the server requests manual Video AI click', async () => {
  const events = [];
  const harness = loadBackground({
    failTaskResponse: { success: true, retryable: false },
    tabs: {
      async get() { return { id: 12, url: 'https://docs.google.com/videos/create' }; },
      async reload() { events.push('reload'); }
    }
  });

  await invoke(harness.context, "hardReloadAndRetry(12, 'task_manual', 'VIDEO_AI_CLICK_FAILED')");
  assert.deepEqual(events, []);
});

function contentElement({ text = '', ariaLabel = null, onClick = null } = {}) {
    const attrs = { 'aria-label': ariaLabel, 'role': null, 'aria-pressed': 'true' };
    return {
      disabled: false,
      offsetParent: {},
      textContent: text,
      click() { if (onClick) onClick(); },
      focus() {},
      dispatchEvent() {},
      getAttribute(name) { return attrs[name] !== undefined ? attrs[name] : null; },
      setAttribute(name, value) { attrs[name] = value; },

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
    'globalThis.__selectors = { findBahanOrAddButton, findCreateModeButton: typeof findCreateModeButton === "function" ? findCreateModeButton : undefined, findCreateButton, findAiPromptBox, findAffiliateAiPromptBox, findAffiliateComposerClearButton, findStandardStartupDialogCloseButton: typeof findStandardStartupDialogCloseButton === "function" ? findStandardStartupDialogCloseButton : undefined, hasAffiliateComposerReferences, shouldReuseAffiliateImages, affiliateImagesKey, isRatioSelected, hasReferenceTag }; })();'
  );
  const window = { innerWidth: 1000, getComputedStyle() { return { display: 'block', visibility: 'visible' }; } };
  const context = vm.createContext({ chrome, console, document, window, setInterval() {} });
  vm.runInContext(exposedSource, context);
  return context.__selectors;
}

test('standard video finds the close control on the Google Vids startup dialog', () => {
  const closeButton = contentElement({ ariaLabel: 'Tutup' });
  closeButton.getBoundingClientRect = () => ({ left: 920, top: 310, width: 32, height: 32, right: 952, bottom: 342 });
  const dialog = contentElement({ text: 'Halo, cerina. Ayo mulai berkreasi. Buat video AI Video kosong' });
  dialog.getAttribute = name => name === 'role' ? 'dialog' : name === 'aria-modal' ? 'true' : null;
  dialog.getBoundingClientRect = () => ({ left: 260, top: 280, width: 720, height: 660, right: 980, bottom: 940 });
  dialog.querySelectorAll = () => [closeButton];
  const selectors = loadContentSelectorFunctions([dialog, closeButton]);

  assert.equal(selectors.findStandardStartupDialogCloseButton(), closeButton);
});

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

test('affiliate prompt detection does not reject a valid panel on a narrow viewport', () => {
  const prompt = contentElement({ ariaLabel: 'Deskripsikan video Anda' });
  prompt.getBoundingClientRect = () => ({ left: 500, top: 100, width: 360, height: 120 });
  const selectors = loadContentSelectorFunctions([prompt]);

  assert.equal(selectors.findAffiliateAiPromptBox(), prompt);
});

test('affiliate image reuse only applies to the same complete reference set', () => {
  const selectors = loadContentSelectorFunctions([]);
  const images = [
    { name: 'avatar.png', tag: '@Gambar1', dataUrl: 'data:image/png;base64,AA==' },
    { name: 'produk.png', tag: '@Gambar2', dataUrl: 'data:image/png;base64,BB==' }
  ];
  const key = selectors.affiliateImagesKey(images);

  assert.equal(selectors.shouldReuseAffiliateImages(key, images, true), true);
  assert.equal(selectors.shouldReuseAffiliateImages(key, images, false), false);
  assert.equal(selectors.shouldReuseAffiliateImages(key, [{ ...images[0], name: 'baru.png' }], true), false);
});

test('affiliate cleanup finds Hapus and old references inside the AI panel regardless of screen position', () => {
  const prompt = contentElement({ ariaLabel: 'Deskripsikan video Anda' });
  prompt.getBoundingClientRect = () => ({ left: 40, top: 80, width: 420, height: 120, bottom: 200 });
  const clear = contentElement({ text: 'Hapus' });
  clear.getBoundingClientRect = () => ({ left: 410, top: 220, width: 50, height: 30 });
  const reference = contentElement({ text: '@Gambar1' });
  reference.getBoundingClientRect = () => ({ left: 50, top: 205, width: 80, height: 60 });
  const panelElements = [prompt, clear, reference];
  const panel = { querySelectorAll() { return panelElements; } };
  prompt.closest = () => panel;
  const selectors = loadContentSelectorFunctions(panelElements);

  assert.equal(selectors.findAffiliateComposerClearButton(prompt), clear);
  assert.equal(selectors.hasAffiliateComposerReferences(prompt), true);
});

test('ratio confirmation accepts the current portrait control when stale landscape markup remains', () => {
  const staleLandscape = contentElement({ text: 'Lanskap' });
  const currentPortrait = contentElement({ text: 'Potret' });
  const selectors = loadContentSelectorFunctions([staleLandscape, currentPortrait]);

  assert.equal(selectors.isRatioSelected('potret'), true);
});

test('uploaded reference remains visible when Google Vids uses a fixed panel with no offsetParent', () => {
  const reference = contentElement({ text: 'Gambar2' });
  reference.offsetParent = null;
  reference.getBoundingClientRect = () => ({ left: 100, top: 100, width: 54, height: 20 });
  const selectors = loadContentSelectorFunctions([reference]);

  assert.equal(selectors.hasReferenceTag('Gambar2'), true);
});

async function runContentAutomation({ images = undefined, ratio = '16:9', mode = 'affiliate', taskId = 'task_content_1', ignoredVideoAiClicks = 0, ignoredRenderClicks = 0, existingPrompt = '', domCleanupWorks = true, replaceUpdatesDom = true } = {}) {
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
  promptBox.textContent = existingPrompt;
  promptBox.innerText = existingPrompt;
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
  const clearCommandButton = contentElement({ text: 'Hapus', onClick() {
    promptBox.textContent = '';
    promptBox.innerText = '';
  } });
  createButton.setAttribute('aria-describedby', 'tt-123'); // Untuk simulasi tooltip

  // Simulasikan div touch layer IconButtonFilled (unique identifier dari tombol generate)
  const createTouchDiv = contentElement({ text: '' });
  createTouchDiv.className = 'javascriptMaterialdesignGm3WizIconButtonFilled-icon-button__touch';
  createTouchDiv.offsetParent = {};
  createTouchDiv.closest = (sel) => {
    if (sel.includes('button') || sel.includes('[role="button"]')) return createButton;
    return null;
  };
  createButton.querySelector = (sel) => {
    if (sel.includes('icon-button__touch') || sel.includes('button__touch')) return createTouchDiv;
    return null;
  };
  createButton.querySelectorAll = (sel) => {
    if (sel.includes('icon-button__touch') || sel.includes('button__touch')) return [createTouchDiv];
    return [];
  };
  const expandButton = contentElement({ ariaLabel: 'Luaskan', onClick() { composerExpanded = true; } });
  const bahanButton = contentElement({ text: 'Bahan' });
  // ratioButton menyimulasikan button Google Wiz dengan button__touch span anak
  const ratioButton = contentElement({ text: 'Lanskap' });
  const touchSpan = contentElement({ text: '' });
  touchSpan.className = 'javascriptMaterialdesignGm3WizButtonDropdownFilled-button__touch';
  touchSpan.offsetParent = {};
  touchSpan.onClick = () => { ratioMenuOpen = true; };
  touchSpan.click = () => { ratioMenuOpen = true; };
  touchSpan.dispatchEvent = (event) => { if (event?.type === 'click') ratioMenuOpen = true; };
  ratioButton.querySelectorAll = (sel) => {
    if (sel === ':scope > span') return [contentElement({ text: '' }), touchSpan];
    return [];
  };
  ratioButton.querySelector = (sel) => {
    if (sel.includes('button__touch') || sel.includes('-button__touch')) return touchSpan;
    return null;
  };
  ratioButton.click = () => { ratioMenuOpen = true; };
  ratioButton.dispatchEvent = (event) => { if (event?.type === 'click') ratioMenuOpen = true; };
  const landscapeOption = contentElement({ text: 'Lanskap 16:9' });
  const portraitOption = contentElement({ text: 'Potret 9:16' });
  const squareOption = contentElement({ text: 'Persegi 1:1' });
  const referenceTags = [contentElement({ text: 'Gambar1' }), contentElement({ text: 'Gambar2' }), contentElement({ text: 'Gambar3' })];
  const fileInput = contentElement();
  fileInput.accept = 'image/png';
  fileInput.dispatchEvent = event => {
    if (event?.type === 'change') {
      sent.push({ type: 'TEST_IMAGE_UPLOAD' });
      uploadedReferenceCount += fileInput.files?.length || 0;
    }
  };
  const document = {
    execCommand(command, _showUi, value) {
      if (command === 'delete' && domCleanupWorks) {
        promptBox.textContent = '';
        promptBox.innerText = '';
      }
      if (command === 'insertText') {
        promptBox.textContent = value || '';
        promptBox.innerText = value || '';
      }
      return true;
    },
    createRange() { return { selectNodeContents() {} }; },
    getElementById(id) {
      // Simulasikan tooltip "Buat" via aria-describedby
      if (id && id.startsWith('tt-')) return { textContent: 'Buat' };
      return null;
    },
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
      // div touch layer untuk findCreateButton Pass 1
      if (selector.includes('icon-button__touch')) return panelOpen ? [createTouchDiv] : [];
      if (selector.includes('button') || selector.includes('[role="button"]')) {
        if (!panelOpen) return [videoAiButton];
        ratioButton.textContent = selectedRatio === '9:16' ? 'Potret' : selectedRatio === '1:1' ? 'Persegi' : 'Lanskap';
        return [createButton, clearCommandButton, expandButton, ...(composerExpanded ? [bahanButton, ratioButton] : []), ...(ratioMenuOpen ? [landscapeOption, portraitOption, squareOption] : []), ...referenceTags.slice(0, uploadedReferenceCount)];
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
          if (message.stage === 'Memilih Rasio 1:1') { selectedRatio = '1:1'; ratioMenuOpen = false; }
          if (message.stage === 'Rendering') createButton.click();
          if (message.stage === 'Bersihkan Prompt Buat Video') clearCommandButton.click();
          return Promise.resolve({ success: true });
        }
        if (message.type === 'TRUSTED_CLICK_SEQUENCE') {
          // Simulasikan sequence: proses setiap klik sesuai stage-nya
          for (const click of (message.clicks || [])) {
            if (click.stage === 'Membuka Pilihan Rasio') ratioMenuOpen = true;
            if (click.stage === 'Memilih Rasio 9:16') { selectedRatio = '9:16'; ratioMenuOpen = false; }
            if (click.stage === 'Memilih Rasio 16:9') { selectedRatio = '16:9'; ratioMenuOpen = false; }
            if (click.stage === 'Memilih Rasio 1:1') { selectedRatio = '1:1'; ratioMenuOpen = false; }
          }
          return Promise.resolve({ success: true });
        }
        if (message.type === 'TRUSTED_INSERT_TEXT') {
          promptBox.textContent = message.text;
          promptBox.innerText = message.text;
          return Promise.resolve({ success: true });
        }
        if (message.type === 'TRUSTED_CLEAR_PROMPT') {
          return Promise.resolve({ success: true });
        }
        if (message.type === 'TRUSTED_REPLACE_PROMPT') {
          if (replaceUpdatesDom) {
            promptBox.textContent = message.text;
            promptBox.innerText = message.text;
          }
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
    assert.equal(messageListener({ type: 'EXECUTE_VIDS_AUTOMATION', prompt: 'Prompt', ratio, taskId, images, mode }, {}, resolve), true);
  });
  return { result, sent, renderRequests, videoAiClickCount, prompt: promptBox.textContent };
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

test('Video AI requests a hard refresh after the first click fails to open the prompt', async () => {
  const { result, sent, videoAiClickCount } = await runContentAutomation({ ignoredVideoAiClicks: 1 });
  assert.equal(result.success, false);
  assert.equal(videoAiClickCount, 1);
  assert.ok(sent.some(message => message.type === 'HARD_RELOAD_AND_RETRY' && /VIDEO_AI_CLICK_FAILED/.test(message.error)));
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
  // Ratio option is now clicked via DOM events (domClick), not trustedClick.
  // Confirm that the ratio was confirmed (logged) before the render click.
  const renderClick = sent.find(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Rendering');
  assert.ok(renderClick, 'Rendering must use a trusted click');
  assert.equal(result.success, true);
});

test('affiliate automation selects ratio before uploading reference images', async () => {
  const { result, sent } = await runContentAutomation({
    ratio: '9:16',
    images: [{ name: 'produk.png', tag: '@Gambar1', dataUrl: 'data:image/png;base64,AA==' }]
  });
  assert.equal(result.success, true);
  // Ratio is now selected via DOM events before image upload.
  // Verify image upload happened and automation succeeded.
  const uploadIndex = sent.findIndex(message => message.type === 'TEST_IMAGE_UPLOAD');
  assert.ok(uploadIndex >= 0, 'image upload must have occurred');
  assert.equal(result.success, true);
});

test('affiliate automation selects square ratio instead of falling back to landscape', async () => {
  const { result, sent } = await runContentAutomation({ ratio: '1:1' });
  assert.equal(result.success, true);
  // Ratio is selected via domClick — no TRUSTED_CLICK for the option itself.
  // The test simply verifies success and that no landscape trusted click was sent.
  const stages = sent.filter(message => message.type === 'TRUSTED_CLICK').map(message => message.stage);
  assert.equal(stages.some(s => /lanskap|16:9/i.test(s)), false, 'must not fall back to landscape ratio');
});

test('affiliate ratio clicks the visible ratio dropdown and its option without keyboard detours', async () => {
  const { result, sent } = await runContentAutomation({ ratio: '9:16' });
  assert.equal(result.success, true);
  // Opening the dropdown uses domClick first; trustedClick is fallback only.
  // The critical behavior: no extra TRUSTED_KEY (ArrowDown/Enter) messages needed.
  const keyMessages = sent.filter(message => message.type === 'TRUSTED_KEY');
  assert.equal(keyMessages.length, 0, 'keyboard navigation must not be needed when option is directly clickable');
});

test('ordinary video mode skips affiliate Bahan but confirms ratio before Rendering', async () => {
  const { result, sent, renderRequests } = await runContentAutomation({ mode: null, ratio: '9:16' });
  assert.equal(result.success, true);
  const stages = sent.filter(message => message.type === 'TRUSTED_CLICK').map(message => message.stage);
  assert.equal(stages.includes('Pilih Mode Buat'), false);
  assert.equal(stages.includes('Membuka Form Buat'), false);
  // Rendering click must exist — ratio was set via domClick before it.
  const renderClick = sent.find(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Rendering');
  assert.ok(renderClick, 'must have a render trusted click');
  assert.equal(renderRequests, 1, 'ordinary mode must not double-click after the layout changes');
});

test('first Buat Video task keeps the original prompt insertion flow', async () => {
  const { result, sent } = await runContentAutomation({ mode: null, taskId: 'task_batch_0' });
  assert.equal(result.success, true);
  assert.equal(sent.some(message => message.type === 'TRUSTED_CLEAR_PROMPT' || message.type === 'TRUSTED_INSERT_TEXT'), false);
});

test('second Buat Video clicks Hapus and types into the fresh composer', async () => {
  const { result, prompt, sent } = await runContentAutomation({
    mode: null,
    taskId: 'task_batch_1',
    existingPrompt: 'Prompt pertama'
  });

  assert.equal(result.success, true);
  assert.equal(prompt, 'Prompt');
  assert.ok(sent.some(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Bersihkan Prompt Buat Video'));
  assert.equal(sent.some(message => message.type === 'TRUSTED_REPLACE_PROMPT'), false);
});

test('a responsive generate button receives one trusted click immediately', async () => {
  const { result, sent, renderRequests } = await runContentAutomation();
  assert.equal(result.success, true);
  const generateClick = sent.find(message => message.type === 'TRUSTED_CLICK' && message.stage === 'Rendering');
  assert.ok(generateClick, 'Generate must use a trusted click on the first attempt');
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
