(function() {
  const cancelledTasks = new Set();
  let activeTaskId = null;
  function ping() { chrome.runtime.sendMessage({ type: 'HEARTBEAT' }, () => void chrome.runtime.lastError); }
  ping();
  setInterval(ping, 3000);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'STOP_AUTOMATION') {
      if (message.taskId) cancelledTasks.add(message.taskId);
      else if (activeTaskId) cancelledTasks.add(activeTaskId);
      sendResponse({ success: true });
      return false;
    }
    if (message?.type !== 'EXECUTE_VIDS_AUTOMATION') return false;
    runDirectAutomation(message)
      .then(result => sendResponse({ success: true, ...result }))
      .catch(error => {
        console.error('[Content] Automasi gagal:', error);
        chrome.runtime.sendMessage({ type: 'AUTOMATION_FAILED', taskId: message.taskId, error: error.message });
        sendResponse({ success: false, error: error.message });
      });
    return true;
  });

  async function runDirectAutomation({ prompt, ratio, taskId, folder }) {
    activeTaskId = taskId;
    cancelledTasks.delete(taskId);

    let promptBox = findVisiblePromptBox();
    if (!promptBox) {
      const videoAiButton = await waitFor(findVideoAiButton, 30000, 250, 'tombol Video AI pada panel kanan');
      simulateClick(videoAiButton);
      try {
        await trustedClick(videoAiButton, taskId, 'Membuka Panel Video AI');
      } catch (_) {}
      
      promptBox = await waitFor(findVisiblePromptBox, 30000, 250, 'kotak prompt Google Vids');
    }

    setPrompt(promptBox, prompt);
    selectRatio(ratio);

    const expandButton = findButton(button =>
      isVisible(button) && button.getAttribute('aria-label') === 'Luaskan'
    );
    if (expandButton) {
      simulateClick(expandButton);
      try { await trustedClick(expandButton, taskId, 'Submitting'); } catch (_) {}
    }

    const createButton = await waitFor(() => Array.from(document.querySelectorAll('button, [role="button"]')).find(button =>
      isVisible(button) &&
      !button.disabled &&
      button.getAttribute('role') !== 'tab' &&
      (button.textContent.trim() === 'Buat' || button.getAttribute('aria-label') === 'Buat' || button.getAttribute('data-tooltip') === 'Buat')
    ), 30000, 250, 'tombol Buat');

    const existingUrls = collectVideoUrls();
    simulateClick(createButton);
    await trustedClick(createButton, taskId, 'Rendering');

    const videoUrl = await awaitVideoResult(existingUrls);
    const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO_FILE', videoUrl, taskId, folder: folder || '' });
    if (!response?.success) throw new Error(response?.error || 'Background gagal mengunduh video.');
    return { videoUrl, downloadId: response.downloadId };
  }

  function findVideoAiButton() {
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="menuitem"], div[tabindex], div[aria-label], span[aria-label], div, span'
    ));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').toLowerCase();
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();

      if (aria.includes('video ai') || aria.includes('buat klip video ai') || tooltip.includes('video ai')) {
        return true;
      }
      if (text === 'video ai' || text.startsWith('video ai')) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.width < 250 && rect.height > 0 && rect.height < 250;
      }
      return false;
    });
  }

  function findVisiblePromptBox() {
    const inputs = Array.from(document.querySelectorAll(
      '[role="textbox"], textarea, [contenteditable="true"], input[type="text"]'
    ));
    return inputs.find(el => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      if (aria.includes('deskripsikan') || aria.includes('prompt') || placeholder.includes('deskripsikan') || placeholder.includes('prompt')) {
        return true;
      }
      return el.getAttribute('role') === 'textbox' || el.hasAttribute('contenteditable');
    });
  }

  function simulateClick(el) {
    if (!el) return;
    try { el.focus(); } catch (_) {}
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventType => {
      el.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y
      }));
    });
    try { el.click(); } catch (_) {}
  }

  function setPrompt(element, prompt) {
    const expected = String(prompt ?? '').trim();
    if (!expected) throw new Error('Prompt kosong.');
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, expected);
    if (!inserted || readPrompt(element) !== normalizePrompt(expected)) {
      element.textContent = expected;
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: expected
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    if (readPrompt(element) !== normalizePrompt(expected)) {
      throw new Error('Google Vids tidak menerima prompt lengkap; proses dibatalkan agar prompt lama tidak digunakan.');
    }
  }

  function normalizePrompt(value) {
    return String(value ?? '').replace(/\u200B/g, '').replace(/\r\n/g, '\n').trim();
  }

  function readPrompt(element) {
    return normalizePrompt('value' in element ? element.value : element.innerText || element.textContent);
  }

  function selectRatio(ratio) {
    const labels = { '16:9': 'Buat video lanskap', '9:16': 'Buat video potret', '1:1': 'Buat video persegi' };
    const button = document.querySelector(`button[aria-label="${labels[ratio] || labels['16:9']}"]`);
    if (button && button.getAttribute('aria-pressed') !== 'true') button.click();
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    return element.offsetParent !== null && rect.width > 0 && rect.height > 0;
  }

  function getElementCenter(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  async function trustedClick(button, taskId, stage) {
    if (!isVisible(button)) throw new Error('Target trusted click tidak terlihat.');
    const response = await chrome.runtime.sendMessage({
      type: 'TRUSTED_CLICK',
      taskId,
      stage,
      ...getElementCenter(button)
    });
    if (!response?.success) throw new Error(response?.error || 'Trusted click gagal.');
  }

  function awaitVideoResult(existingUrls) {
    return waitFor(() => {
      return [...collectVideoUrls()].find(url =>
        !existingUrls.has(url) && url.includes('usercontent.google.com')
      ) || null;
    }, 240000, 2000, 'video hasil render');
  }

  function collectVideoUrls() {
    const urls = new Set();
    for (const video of document.querySelectorAll('video')) {
      if (video.src) urls.add(video.src);
      if (video.currentSrc) urls.add(video.currentSrc);
      for (const source of video.querySelectorAll('source[src]')) {
        if (source.src) urls.add(source.src);
      }
    }
    return urls;
  }

  function findButton(predicate) {
    return Array.from(document.querySelectorAll('button, [role="button"]')).find(predicate);
  }

  function waitFor(getValue, timeout = 15000, interval = 250, label = 'elemen/hasil') {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (activeTaskId && cancelledTasks.has(activeTaskId)) {
          clearInterval(timer);
          reject(new Error('Automasi dihentikan oleh pengguna.'));
          return;
        }
        const value = getValue();
        if (value) { clearInterval(timer); resolve(value); }
        else if (Date.now() - startedAt >= timeout) {
          clearInterval(timer);
          reject(new Error(`${label} tidak ditemukan setelah ${Math.round(timeout / 1000)} detik.`));
        }
      }, interval);
    });
  }
})();
