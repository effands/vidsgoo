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
    const findVisiblePromptBox = () => Array.from(
      document.querySelectorAll('[role="textbox"][aria-label^="Deskripsikan video Anda"]')
    ).find(isVisible);
    const existingPromptBox = findVisiblePromptBox();
    if (!existingPromptBox) {
      const videoAiButton = await waitFor(() => findButton(button => {
        const text = button.textContent.trim();
        return isVisible(button) && (button.getAttribute('aria-label') === 'Buat klip video AI' ||
          text === 'Video AI' || text.startsWith('Buat video AI'));
      }), 30000, 250, 'tombol Video AI');
      videoAiButton.click();
    }

    const promptBox = await waitFor(findVisiblePromptBox, 30000, 250, 'kotak prompt Google Vids');
    setPrompt(promptBox, prompt);
    selectRatio(ratio);

    const expandButton = findButton(button =>
      isVisible(button) && button.getAttribute('aria-label') === 'Luaskan'
    );
    if (expandButton) await trustedClick(expandButton, taskId, 'Submitting');

    const createButton = await waitFor(() => Array.from(document.querySelectorAll('button')).find(button =>
      isVisible(button) &&
      !button.disabled &&
      button.getAttribute('role') !== 'tab' &&
      (button.textContent.trim() === 'Buat' || button.getAttribute('aria-label') === 'Buat')
    ), 30000, 250, 'tombol Buat');
    const existingUrls = collectVideoUrls();
    await trustedClick(createButton, taskId, 'Rendering');

    const videoUrl = await awaitVideoResult(existingUrls);
    const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO_FILE', videoUrl, taskId, folder: folder || '' });
    if (!response?.success) throw new Error(response?.error || 'Background gagal mengunduh video.');
    return { videoUrl, downloadId: response.downloadId };
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
