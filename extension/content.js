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

  async function runDirectAutomation({ prompt, ratio, taskId, folder, images, mode }) {
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

    // Unggah / lampirkan gambar (Avatar & Produk) jika tersedia pada antrean task
    if (Array.isArray(images) && images.length > 0) {
      await attachImagesToVids(images, promptBox, taskId);
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

  function dataUrlToFile(dataUrl, filename) {
    if (!dataUrl || !dataUrl.includes(',')) return null;
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(parts[1]);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return new File([array], filename || 'image.png', { type: mime });
  }

  async function attachImagesToVids(images, promptBox, taskId) {
    const files = images
      .map((img, idx) => dataUrlToFile(img.dataUrl, img.name || `gambar_${idx + 1}.png`))
      .filter(Boolean);

    if (!files.length) return;

    // Klik tombol 'Bahan' atau '+ Tambahkan' jika ada kotak upload
    const bahanButton = findBahanOrAddButton();
    if (bahanButton) {
      simulateClick(bahanButton);
      try { await trustedClick(bahanButton, taskId, 'Klik Bahan Upload'); } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
      
      const uploadMenuItem = findUploadMenuItem();
      if (uploadMenuItem) {
        simulateClick(uploadMenuItem);
        try { await trustedClick(uploadMenuItem, taskId, 'Pilih Upload File'); } catch (_) {}
        await new Promise(r => setTimeout(r, 400));
      }
    }

    // Injeksi via file input
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (fileInputs.length > 0) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      for (const input of fileInputs) {
        try {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (_) {}
      }
    }

    // Injeksi via Drag & Drop Event
    try {
      const dropTarget = document.querySelector('[role="textbox"]') || promptBox;
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      dropTarget.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      dropTarget.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
      dropTarget.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    } catch (_) {}

    // Injeksi via Paste Event
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      promptBox.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (_) {}

    await new Promise(r => setTimeout(r, 1500));
  }

  function findBahanOrAddButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], div, span'));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').toLowerCase();
      return text === 'bahan' || text === '+ tambahkan' || text === 'tambahkan' ||
             aria.includes('tambahkan') || aria.includes('bahan') || tooltip.includes('bahan');
    });
  }

  function findUploadMenuItem() {
    const candidates = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], div, span'));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return text === 'upload' || text.startsWith('upload') || aria.includes('upload');
    });
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
