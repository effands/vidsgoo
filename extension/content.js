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

    // 1. Pastikan panel 'Video AI' di toolbar sisi kanan terbuka
    let promptBox = findAiPromptBox();
    if (!promptBox) {
      console.log('[Content] Panel Video AI belum terbuka. Membuka tombol Video AI di toolbar kanan...');
      const videoAiButton = await waitFor(findVideoAiButton, 30000, 250, 'tombol Video AI pada toolbar kanan');
      videoAiButton.scrollIntoView?.({ block: 'center' });
      simulateClick(videoAiButton);
      try {
        await trustedClick(videoAiButton, taskId, 'Membuka Panel Video AI');
      } catch (_) {}
      
      promptBox = await waitFor(findAiPromptBox, 30000, 250, 'kotak prompt Google Vids');
    }

    // 2. Unggah gambar referensi (Avatar & Produk) TERLEBIH DAHULU sebelum mengetik script
    if (Array.isArray(images) && images.length > 0) {
      await attachImagesToVids(images, promptBox, taskId);
    }

    // 3. Masukkan prompt dengan mode ketik & pemilihan chip @Gambar
    await typePromptWithMentions(promptBox, prompt, taskId);
    selectRatio(ratio);

    // 4. Perluas jika ada tombol Luaskan
    const expandButton = findButton(button =>
      isVisible(button) && button.getAttribute('aria-label') === 'Luaskan'
    );
    if (expandButton) {
      simulateClick(expandButton);
      try { await trustedClick(expandButton, taskId, 'Submitting'); } catch (_) {}
    }

    // 5. Klik tombol Buat / Kirim (Tombol panah biru atau teks Buat)
    const createButton = await waitFor(findCreateButton, 30000, 250, 'tombol Buat / Kirim');

    const existingUrls = collectVideoUrls();
    simulateClick(createButton);
    await trustedClick(createButton, taskId, 'Rendering');

    // 6. Tunggu render video selesai dan unduh
    const videoUrl = await awaitVideoResult(existingUrls);
    const response = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_VIDEO_FILE', videoUrl, taskId, folder: folder || '' });
    if (!response?.success) throw new Error(response?.error || 'Background gagal mengunduh video.');
    return { videoUrl, downloadId: response.downloadId };
  }

  function findAiPromptBox() {
    const inputs = Array.from(document.querySelectorAll(
      '[role="textbox"], textarea, [contenteditable="true"], input[type="text"]'
    ));
    return inputs.find(el => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();

      // Specifically the video description textbox inside Video AI prompt panel
      if (aria.includes('deskripsikan') || placeholder.includes('deskripsikan') ||
          aria.includes('perintah') || placeholder.includes('perintah') ||
          aria.includes('prompt') || placeholder.includes('prompt')) {
        return true;
      }

      // Check if inside AI sidebar with "Buat" / "Edit" tabs or buttons
      const sidebarParent = el.closest('[aria-label*="Video AI"], [aria-label*="Klip video"], [role="region"], [role="dialog"], div');
      if (sidebarParent && sidebarParent.textContent.includes('Buat') && (aria.includes('video') || placeholder.includes('video'))) {
        return true;
      }

      return false;
    }) || null;
  }

  function findVideoAiButton() {
    // 1. Target exact Google Vids video-generation icon from DevTools
    const icon = document.querySelector('.docs-icon-video-generation-20');
    if (icon && isVisible(icon)) {
      return icon.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box') ||
             icon.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box') ||
             icon;
    }

    // 2. Target exact label element
    const labels = Array.from(document.querySelectorAll('.appsSketchyContentLibraryRailToolbarButtonLabelRefreshed'));
    const label = labels.find(l => isVisible(l) && (l.textContent || '').trim().toLowerCase() === 'video ai');
    if (label) {
      return label.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box') ||
             label.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box') ||
             label;
    }

    // 3. Any toolbar button with class appsSketchyContentLibraryRailToolbarButton
    const outerBoxes = Array.from(document.querySelectorAll('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box, .appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box'));
    const box = outerBoxes.find(b => isVisible(b) && (b.textContent || '').toLowerCase().includes('video ai'));
    if (box) return box;

    // 4. Fallback search across all buttons and clickable divs
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="menuitem"], div[tabindex], div[aria-label], span[aria-label], div, span'
    ));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').toLowerCase();
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();

      if (aria === 'video ai' || aria.includes('video ai') || aria.includes('buat klip video ai') ||
          tooltip === 'video ai' || tooltip.includes('video ai') ||
          text === 'video ai' || text.startsWith('video ai')) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.width < 250 && rect.height > 0 && rect.height < 250;
      }
      return false;
    });
  }

  function findCreateButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'));
    return candidates.find(button => {
      if (!isVisible(button) || button.disabled) return false;
      if (button.getAttribute('role') === 'tab') return false;
      const text = (button.textContent || '').trim().toLowerCase();
      const aria = (button.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (button.getAttribute('data-tooltip') || '').toLowerCase();

      if (text === 'buat' || aria === 'buat' || tooltip === 'buat' ||
          text === 'kirim' || aria === 'kirim' || tooltip === 'kirim' ||
          aria.includes('buat video') || aria.includes('kirim perintah')) {
        return true;
      }

      // Check blue circular submit button (arrow up icon)
      const rect = button.getBoundingClientRect();
      const isCircularSubmit = rect.width >= 24 && rect.width <= 70 && rect.height >= 24 && rect.height <= 70;
      if (isCircularSubmit && (aria.includes('buat') || aria.includes('kirim') || aria.includes('submit') || text === '')) {
        return true;
      }
      return false;
    });
  }

  async function typePromptWithMentions(promptBox, promptText, taskId) {
    const raw = String(promptText ?? '').trim();
    if (!raw) throw new Error('Prompt kosong.');
    promptBox.focus();

    // Clear existing content in prompt box
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(promptBox);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);

    // Split text by mention tokens like @Gambar1, @Gambar2, @Gambar3
    const tokenRegex = /(@Gambar\d+)/gi;
    const parts = raw.split(tokenRegex);

    for (const part of parts) {
      if (!part) continue;

      const match = part.match(/^@Gambar(\d+)$/i);
      if (match) {
        const imageIndex = match[1];
        const tagLabel = `Gambar${imageIndex}`;

        // Ketik '@' untuk memunculkan popup mention pilihan gambar
        insertTextAtCaret(promptBox, '@');
        await new Promise(r => setTimeout(r, 450));

        // Cari popover suggestion yang berisi 'Gambar1', 'Gambar2', dst.
        const suggestion = await findMentionSuggestion(tagLabel, imageIndex);
        if (suggestion) {
          simulateClick(suggestion);
          try { await trustedClick(suggestion, taskId, `Pilih Chip ${tagLabel}`); } catch (_) {}
          await new Promise(r => setTimeout(r, 300));
        } else {
          // Fallback jika menu suggestion tidak terbuka, tekan Enter atau selesaikan teks
          dispatchEnterKey(promptBox);
          await new Promise(r => setTimeout(r, 200));
          const currentText = readPrompt(promptBox);
          if (!currentText.includes(tagLabel)) {
            insertTextAtCaret(promptBox, tagLabel);
          }
        }
      } else {
        // Segmen teks biasa
        insertTextAtCaret(promptBox, part);
        await new Promise(r => setTimeout(r, 60));
      }
    }

    promptBox.dispatchEvent(new InputEvent('input', { bubbles: true }));
    promptBox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function insertTextAtCaret(element, text) {
    element.focus();
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      const sel = window.getSelection();
      if (sel.getRangeAt && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
  }

  function dispatchEnterKey(element) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent('keydown', opts));
    element.dispatchEvent(new KeyboardEvent('keypress', opts));
    element.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function findMentionSuggestion(tagLabel, index) {
    for (let i = 0; i < 6; i++) {
      const popups = Array.from(document.querySelectorAll(
        '[role="menuitem"], [role="option"], [role="listbox"] div, div[tabindex], div, span, img'
      ));
      const match = popups.find(el => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (text.includes(tagLabel) || text.includes(`Gambar ${index}`) || aria.includes(tagLabel.toLowerCase())) {
          const rect = el.getBoundingClientRect();
          return rect.width > 15 && rect.width < 320 && rect.height > 15 && rect.height < 320;
        }
        return false;
      });
      if (match) return match;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
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

    console.log(`[Content] Memulai upload ${files.length} file gambar ke Google Vids...`);

    // 1. Klik tombol '+ Tambahkan' atau 'Bahan'
    const addBtn = findBahanOrAddButton();
    if (addBtn) {
      simulateClick(addBtn);
      try { await trustedClick(addBtn, taskId, 'Klik Tambah Gambar'); } catch (_) {}
      await new Promise(r => setTimeout(r, 500));

      const uploadItem = findUploadMenuItem();
      if (uploadItem) {
        simulateClick(uploadItem);
        try { await trustedClick(uploadItem, taskId, 'Pilih Upload File'); } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 2. Injeksi berkas gambar ke input[type="file"]
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

    // 3. Drag & Drop ke promptBox
    try {
      const dropTarget = document.querySelector('[role="textbox"]') || promptBox;
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      dropTarget.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      dropTarget.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
      dropTarget.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    } catch (_) {}

    // 4. Paste ke promptBox
    try {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      promptBox.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
    } catch (_) {}

    // Beri jeda agar Google Vids selesai memproses thumbnail chip (@Gambar1, @Gambar2)
    await new Promise(r => setTimeout(r, 2000));
  }

  function findBahanOrAddButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div[tabindex], div, span'));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').toLowerCase();
      return text === 'tambahkan' || text === '+ tambahkan' || text.includes('tambahkan') ||
             text === 'bahan' || text.includes('bahan') ||
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

  function simulateClick(el) {
    if (!el) return;
    try { el.focus(); } catch (_) {}
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    try { el.click(); } catch (_) {}
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
