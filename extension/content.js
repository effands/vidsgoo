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
    const isAffiliate = mode === 'affiliate';

    // 1. Pastikan panel 'Video AI' di toolbar sisi kanan terbuka
    const findTaskPromptBox = isAffiliate ? findAffiliateAiPromptBox : findAiPromptBox;
    let promptBox = findTaskPromptBox();
    if (!promptBox) {
      console.log('[Content] Panel Video AI belum terbuka. Membuka tombol Video AI di toolbar kanan...');
      let lastOpenError = null;
      for (let attempt = 1; attempt <= 3 && !promptBox; attempt++) {
        const videoAiButton = await waitFor(findVideoAiButton, 10000, 250, 'tombol Video AI pada toolbar kanan');
        videoAiButton.scrollIntoView?.({ block: 'center' });
        try {
          await trustedClick(videoAiButton, taskId, 'Membuka Panel Video AI' + (attempt > 1 ? ' (percobaan ' + attempt + ')' : ''));
        } catch (_) {
          simulateClick(videoAiButton);
        }
        try {
          promptBox = await waitFor(findTaskPromptBox, 6000, 250, 'kotak prompt Google Vids');
        } catch (error) {
          lastOpenError = error;
          promptBox = findTaskPromptBox();
        }
      }
      if (!promptBox) throw lastOpenError || new Error('Panel Video AI gagal dibuka setelah 3 percobaan.');
    }

    let createButton;
    if (isAffiliate) {
      const createModeButton = await waitFor(findCreateModeButton, 15000, 250, 'tab Buat pada panel Video AI');
      try { await trustedClick(createModeButton, taskId, 'Pilih Mode Buat'); }
      catch (_) { simulateClick(createModeButton); }
      promptBox = await waitFor(findAffiliateAiPromptBox, 15000, 250, 'kotak prompt Google Vids pada mode Buat');

      const expandButton = findButton(button => isVisible(button) && button.getAttribute('aria-label') === 'Luaskan');
      if (expandButton) {
        try { await trustedClick(expandButton, taskId, 'Membuka Form Buat'); }
        catch (_) { simulateClick(expandButton); }
        promptBox = await waitFor(findAffiliateAiPromptBox, 15000, 250, 'kotak prompt Google Vids yang diperluas');
      }
      try {
        await clearPreviousAffiliateComposer(promptBox, taskId);
      } catch (error) {
        await chrome.runtime.sendMessage({
          type: 'HARD_RELOAD_AND_RETRY',
          taskId,
          error: error.message
        });
        throw new Error(`RETRY_AFTER_HARD_RELOAD: ${error.message}`);
      }
      promptBox = await waitFor(findAffiliateAiPromptBox, 15000, 200, 'kotak prompt affiliate setelah dibersihkan');
      if (Array.isArray(images) && images.length > 0) await attachImagesToVids(images, promptBox, taskId, true);
      await typePromptWithMentions(promptBox, prompt, taskId);
      await selectAffiliateVidsRatio(ratio, taskId);
      createButton = await waitFor(findCreateButton, 30000, 250, 'tombol Buat / Kirim');
    } else {
      // Pertahankan alur video biasa yang lama; perubahan affiliate tidak boleh masuk ke jalur ini.
      if (Array.isArray(images) && images.length > 0) await attachImagesToVids(images, promptBox, taskId);
      await typePromptWithMentions(promptBox, prompt, taskId);
      const expandButton = findButton(button => isVisible(button) && button.getAttribute('aria-label') === 'Luaskan');
      if (expandButton) {
        try { await trustedClick(expandButton, taskId, 'Submitting'); }
        catch (_) { simulateClick(expandButton); }
        promptBox = await waitFor(findAiPromptBox, 15000, 250, 'kotak prompt Google Vids yang diperluas');
      }
      await selectVidsRatio(ratio, taskId);
      createButton = await waitFor(findCreateButton, 30000, 250, 'tombol Buat / Kirim');
    }

    const existingUrls = collectVideoUrls();
    await clickCreateAndConfirm(createButton, taskId, existingUrls);

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
      const aiPanel = el.closest?.('[role="complementary"], [aria-label*="Klip video AI"], [aria-label*="Video AI"]');
      if (!aiPanel) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();

      // Specifically the video description textbox inside Video AI prompt panel
      if (aria.includes('deskripsikan') || placeholder.includes('deskripsikan') ||
          aria.includes('perintah') || placeholder.includes('perintah') ||
          aria.includes('prompt') || placeholder.includes('prompt')) {
        return true;
      }

      // Check if inside AI sidebar with "Buat" / "Edit" tabs or buttons
      if (aiPanel.textContent.includes('Buat') && (aria.includes('video') || placeholder.includes('video'))) {
        return true;
      }

      return false;
    }) || null;
  }

  // Affiliate memakai editor contenteditable yang struktur/aria-nya sering berubah.
  // Batasi pencarian ke rail kanan agar tidak pernah memilih textbox di kanvas utama.
  function findAffiliateAiPromptBox() {
    const inputs = Array.from(document.querySelectorAll(
      '[role="textbox"], textarea, [contenteditable="true"], input[type="text"]'
    ));
    return inputs.find(el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.left < window.innerWidth * 0.62) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const semanticPrompt = ['deskripsikan', 'perintah', 'prompt', 'video']
        .some(word => aria.includes(word) || placeholder.includes(word));
      const panel = el.closest?.('[role="complementary"]') || el.parentElement;
      const panelText = (panel?.textContent || '').toLowerCase();
      return semanticPrompt || panelText.includes('buat') || panelText.includes('animasi');
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
      if (isCircularSubmit && (aria.includes('buat') || aria.includes('kirim') || aria.includes('submit') || tooltip === 'buat')) {
        return true;
      }
      return false;
    });
  }

  async function clickCreateAndConfirm(initialButton, taskId, existingUrls) {
    let button = initialButton;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt === 1) {
        simulateClick(button);
      } else {
        try { await trustedClick(button, taskId, 'Rendering'); }
        catch (_) { simulateClick(button); }
      }
      try {
        await waitFor(() => isRenderStarted(existingUrls), 5000, 250, 'indikator proses render');
        return;
      } catch (error) {
        lastError = error;
      }
      button = await waitFor(findCreateButton, 5000, 250, 'tombol Buat / Kirim untuk percobaan ulang');
    }
    throw lastError || new Error('Google Vids tidak memulai render setelah 3 percobaan.');
  }

  function isRenderStarted(existingUrls) {
    if ([...collectVideoUrls()].some(url => !existingUrls.has(url))) return true;
    return Array.from(document.querySelectorAll('[role="progressbar"], button, [role="button"], div, span')).some(el => {
      if (!isVisible(el)) return false;
      const label = elementLabel(el);
      return label.includes('wujudkan visi anda') || label.includes('proses ini perlu waktu') ||
             label === 'batal' || label.includes('cancel generation') || /^\d{1,3}%$/.test(label);
    });
  }

  async function typePromptWithMentions(promptBox, promptText, taskId) {
    const raw = String(promptText ?? '').trim();
    if (!raw) throw new Error('Prompt kosong.');
    promptBox.focus();

    await clearPromptBox(promptBox);

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
        if (!suggestion) throw new Error('Pilihan @' + tagLabel + ' tidak muncul setelah gambar diunggah.');
        try { await trustedClick(suggestion, taskId, 'Pilih Chip ' + tagLabel); }
        catch (_) { simulateClick(suggestion); }
        await new Promise(r => setTimeout(r, 300));
      } else {
        // Segmen teks biasa
        insertTextAtCaret(promptBox, part);
        await new Promise(r => setTimeout(r, 60));
      }
    }

    promptBox.dispatchEvent(new InputEvent('input', { bubbles: true }));
    promptBox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function clearPromptBox(promptBox) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      promptBox.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(promptBox);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete', false, null);
      promptBox.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'deleteContentBackward',
        data: null
      }));
      promptBox.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 250));
      if (!readPrompt(promptBox)) return;
    }
    throw new Error('Prompt lama Google Vids tidak berhasil dibersihkan.');
  }

  async function clearPreviousAffiliateComposer(promptBox, taskId) {
    const clearButton = findAffiliateComposerClearButton(promptBox);
    const hasPrompt = Boolean(readPrompt(promptBox));
    const hasReferences = hasAffiliateComposerReferences(promptBox);
    if (!clearButton || (!hasPrompt && !hasReferences)) return;

    try { await trustedClick(clearButton, taskId, 'Bersihkan Form Affiliate'); }
    catch (_) { simulateClick(clearButton); }

    await waitFor(() => {
      const currentPrompt = findAffiliateAiPromptBox();
      if (!currentPrompt || readPrompt(currentPrompt)) return null;
      return hasAffiliateComposerReferences(currentPrompt) ? null : currentPrompt;
    }, 10000, 200, 'form affiliate kosong sebelum task berikutnya');
  }

  function findAffiliateComposerClearButton(promptBox) {
    const promptRect = promptBox.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter(button => {
      if (!isVisible(button) || button.disabled) return false;
      if (elementLabel(button) !== 'hapus') return false;
      const rect = button.getBoundingClientRect();
      return rect.left > window.innerWidth * 0.62 && rect.top >= promptRect.top;
    });
    return candidates.sort((a, b) =>
      Math.abs(a.getBoundingClientRect().top - promptRect.bottom) -
      Math.abs(b.getBoundingClientRect().top - promptRect.bottom)
    )[0] || null;
  }

  function hasAffiliateComposerReferences(promptBox) {
    const promptRect = promptBox.getBoundingClientRect();
    return Array.from(document.querySelectorAll('[aria-label], [data-tooltip], span')).some(el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.left < window.innerWidth * 0.62 || rect.top < promptRect.top) return false;
      return /^@?gambar\d+$/i.test((el.textContent || '').trim()) ||
        /gambar\d+/i.test(el.getAttribute('aria-label') || '') ||
        /gambar\d+/i.test(el.getAttribute('data-tooltip') || '');
    });
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
        '[role="menuitem"], [role="option"], [role="listbox"] [role="button"], [role="dialog"] [role="button"]'
      ));
      const match = popups.find(el => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (text === tagLabel || text.startsWith(tagLabel + ' ') || text === 'Gambar ' + index || aria === tagLabel.toLowerCase() || aria.startsWith(tagLabel.toLowerCase() + ' ')) {
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

  async function attachImagesToVids(images, promptBox, taskId, preferNewestInput = false) {
    const files = images.slice(0, 3).map((img, idx) => ({
      file: dataUrlToFile(img.dataUrl, img.name || 'gambar_' + (idx + 1) + '.png'),
      tag: String(img.tag || '@Gambar' + (idx + 1)).replace(/^@/, '')
    })).filter(item => item.file);
    if (!files.length) return;
    // Jangan klik Bahan: klik tersebut memanggil file picker native Windows yang
    // tetap terbuka walaupun file sudah dimasukkan secara programatis.
    // Google Vids memproses satu file per event change. Cari ulang input setiap
    // putaran karena elemen dapat dirender ulang setelah satu gambar masuk.
    for (const { file, tag } of files) {
      let uploaded = false;
      let lastError = null;
      for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
        const fileInput = await waitFor(
          () => findImageFileInput(preferNewestInput), 15000, 250, 'input unggah gambar Google Vids'
        );
        const dt = new DataTransfer();
        dt.items.add(file);
        try { fileInput.value = ''; } catch (_) {}
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        try {
          await waitFor(() => hasReferenceTag(tag), 20000, 400, 'referensi @' + tag + ' selesai diunggah');
          uploaded = true;
        } catch (error) {
          lastError = error;
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }
      if (!uploaded) throw lastError || new Error('Pilihan @' + tag + ' tidak muncul setelah gambar diunggah.');
      await new Promise(resolve => setTimeout(resolve, 1600));
    }
  }

  function findImageFileInput(preferNewest = false) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(input => {
      if (input.disabled) return false;
      const accept = (input.accept || '').toLowerCase();
      return !accept || accept.includes('image') || /png|jpe?g|webp/.test(accept);
    });
    return (preferNewest ? inputs.at(-1) : inputs[0]) || null;
  }

  function hasReferenceTag(tagLabel) {
    const expected = String(tagLabel).replace(/^@/, '').toLowerCase();
    return Array.from(document.querySelectorAll('[aria-label], [data-tooltip], [role="button"], [role="option"], span')).some(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').trim().toLowerCase();
      return text === expected || text === '@' + expected || aria.includes(expected) || tooltip.includes(expected);
    });
  }

  function findBahanOrAddButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], div[tabindex]'));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').trim().toLowerCase();
      return text === 'bahan' || aria === 'bahan' || tooltip === 'bahan';
    });
  }

  function findCreateModeButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="tab"], div[tabindex]'));
    return candidates.find(el => {
      if (!isVisible(el) || el.disabled) return false;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || '').trim().toLowerCase();
      return text === 'buat' || aria === 'buat' || tooltip === 'buat';
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

  async function selectVidsRatio(ratio, taskId) {
    const wanted = ratio === '9:16' ? 'potret' : 'lanskap';
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const active = await waitFor(findRatioButton, 15000, 250, 'tombol rasio aspek');
      if (elementLabel(active).includes(wanted)) return;

      let option = findRatioOption(wanted);
      if (!option) {
        try { await trustedClick(active, taskId, 'Membuka Pilihan Rasio'); }
        catch (_) { simulateClick(active); }
        option = await waitFor(() => findRatioOption(wanted), 5000, 200, 'pilihan rasio ' + ratio);
      }

      try {
        await trustedClick(option, taskId, 'Memilih Rasio ' + ratio + (attempt > 1 ? ' (percobaan ' + attempt + ')' : ''));
      } catch (_) {
        simulateClick(option);
      }

      try {
        await waitFor(() => {
          const selected = findRatioButton();
          return selected && elementLabel(selected).includes(wanted) ? selected : null;
        }, 3000, 200, 'konfirmasi rasio ' + ratio);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Rasio ' + ratio + ' tidak berhasil dipilih setelah 3 percobaan.');
  }

  async function selectAffiliateVidsRatio(ratio, taskId) {
    const wanted = ratio === '9:16' ? 'potret' : 'lanskap';
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const active = await waitFor(findRatioButton, 15000, 200, 'tombol rasio aspek affiliate');
      if (elementLabel(active).includes(wanted)) return;

      let option = findAffiliateRatioOption(wanted);
      if (!option) {
        // Google Vids mengabaikan click() DOM pada dropdown ini. Fokuskan elemen
        // yang tepat lalu kirim Enter tepercaya agar tidak bergantung koordinat.
        try { await trustedKeyPress(active, taskId, 'Membuka Pilihan Rasio'); }
        catch (_) { simulateClick(active); }
        try {
          option = await waitFor(() => findAffiliateRatioOption(wanted), 2500, 100, 'pilihan rasio affiliate ' + ratio);
        } catch (error) {
          try { await trustedClick(active, taskId, 'Membuka Pilihan Rasio'); }
          catch (_) { simulateClick(active); }
          try {
            option = await waitFor(() => findAffiliateRatioOption(wanted), 2500, 100, 'pilihan rasio affiliate ' + ratio);
          } catch (fallbackError) {
            lastError = fallbackError;
            continue;
          }
        }
      }

      try { await trustedKeyPress(option, taskId, 'Memilih Rasio ' + ratio); }
      catch (_) { simulateClick(option); }
      try {
        await waitFor(() => {
          const selected = findRatioButton();
          return selected && elementLabel(selected).includes(wanted) ? selected : null;
        }, 1200, 100, 'konfirmasi rasio affiliate ' + ratio);
        return;
      } catch (error) {
        lastError = error;
        try { await trustedClick(option, taskId, 'Memilih Rasio ' + ratio); }
        catch (_) { simulateClick(option); }
        try {
          await waitFor(() => {
            const selected = findRatioButton();
            return selected && elementLabel(selected).includes(wanted) ? selected : null;
          }, 2500, 100, 'konfirmasi rasio affiliate ' + ratio);
          return;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
    }
    throw lastError || new Error('Rasio affiliate ' + ratio + ' tidak berhasil dipilih.');
  }

  function findAffiliateRatioOption(wanted) {
    const standardOption = findRatioOption(wanted);
    if (standardOption) return standardOption;
    const expected = wanted === 'potret' ? 'potret 9:16' : 'lanskap 16:9';
    const matches = Array.from(document.querySelectorAll('body *')).filter(el => {
      if (!isVisible(el) || el.disabled) return false;
      const label = elementLabel(el);
      if (!label.includes(expected)) return false;
      const childWithSameLabel = Array.from(el.children || []).some(child =>
        isVisible(child) && elementLabel(child).includes(expected)
      );
      return !childWithSameLabel;
    });
    const leaf = matches[0];
    return leaf?.closest?.('button, [role="button"], [role="option"], [role="menuitem"], [tabindex]') || leaf || null;
  }

  function elementLabel(element) {
    return [element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('data-tooltip')]
      .filter(Boolean).join(' ').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function findRatioButton() {
    const controls = Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => {
      if (!isVisible(el) || el.disabled) return false;
      const tooltip = Array.from(el.querySelectorAll?.('[role="tooltip"]') || [])
        .some(node => /rasio aspek/i.test(node.textContent || ''));
      const gm3Dropdown = /WizButtonDropdownFilled-button/.test(el.className || '');
      const label = elementLabel(el);
      return tooltip || gm3Dropdown && (label.includes('lanskap') || label.includes('potret'));
    });
    return controls[0] || Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
      if (!isVisible(el) || el.disabled) return false;
      const label = elementLabel(el);
      return label === 'lanskap' || label === 'potret' || label.includes('rasio aspek');
    }) || null;
  }

  function findRatioOption(wanted) {
    return Array.from(document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"]')).find(el => {
      if (!isVisible(el) || el.disabled) return false;
      const label = elementLabel(el);
      return wanted === 'potret' ? label.includes('potret 9:16') : label.includes('lanskap 16:9');
    }) || null;
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

  async function trustedKeyPress(element, taskId, stage) {
    if (!isVisible(element)) throw new Error('Target trusted key tidak terlihat.');
    element.focus();
    const response = await chrome.runtime.sendMessage({
      type: 'TRUSTED_KEY',
      taskId,
      stage,
      key: 'Enter'
    });
    if (!response?.success) throw new Error(response?.error || 'Trusted key gagal.');
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
