(function() {
  if (globalThis.__VIDS_GOO_CONTENT_SCRIPT_ACTIVE__) return;
  globalThis.__VIDS_GOO_CONTENT_SCRIPT_ACTIVE__ = true;

  const cancelledTasks = new Set();
  let activeTaskId = null;
  let lastAffiliateImagesKey = null;
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

  function isVideoAiPanelOpen() {
    const videoAiBtn = document.getElementById('content-library-rail-video-generation-element') ||
                       document.querySelector('[data-tooltip="Buat klip video AI"], [aria-label="Buat klip video AI"], [aria-label="Video AI"]');
    if (videoAiBtn && videoAiBtn.getAttribute('aria-pressed') === 'true') {
      return true;
    }
    const promptBox = findAffiliateAiPromptBox() || findAiPromptBox();
    if (promptBox && isVisible(promptBox)) return true;
    return false;
  }

  async function runDirectAutomation({ prompt, ratio, taskId, folder, images, mode }) {
    activeTaskId = taskId;
    cancelledTasks.delete(taskId);
    const isAffiliate = mode === 'affiliate';

    if (!isAffiliate) await closeStandardStartupDialog(taskId);

    // 1. Pastikan panel 'Video AI' di toolbar sisi kanan terbuka
    const findTaskPromptBox = isAffiliate ? findAffiliateAiPromptBox : findAiPromptBox;
    let promptBox = findTaskPromptBox();
    if (!promptBox && !isVideoAiPanelOpen()) {
      console.log('[Content] Panel Video AI belum terbuka. Membuka tombol Video AI di toolbar kanan...');
      const videoAiButton = await waitFor(findVideoAiButton, 10000, 250, 'tombol Video AI pada toolbar kanan');
      videoAiButton.scrollIntoView?.({ block: 'center' });
      try {
        await trustedClick(videoAiButton, taskId, 'Membuka Panel Video AI');
      } catch (_) {
        simulateClick(videoAiButton);
      }
    }
    try {
      promptBox = await waitFor(findTaskPromptBox, 15000, 250, 'kotak prompt Google Vids');
    } catch (error) {
        await chrome.runtime.sendMessage({
          type: 'HARD_RELOAD_AND_RETRY',
          taskId,
          error: 'VIDEO_AI_CLICK_FAILED: Panel Video AI tidak terbuka setelah satu klik.'
        });
      throw new Error(`RETRY_AFTER_HARD_RELOAD: ${error.message}`);
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
      const requestedImages = Array.isArray(images) ? images : [];
      const referencesPresent = requestedImages.length > 0 && requestedImages.every(image =>
        hasReferenceTag(String(image?.tag || '').replace(/^@/, ''))
      );
      const reuseImages = shouldReuseAffiliateImages(lastAffiliateImagesKey, requestedImages, referencesPresent);
      try {
        if (reuseImages) await clearPromptBox(promptBox);
        else await clearPreviousAffiliateComposer(promptBox, taskId);
      } catch (error) {
        await chrome.runtime.sendMessage({
          type: 'HARD_RELOAD_AND_RETRY',
          taskId,
          error: error.message
        });
        throw new Error(`RETRY_AFTER_HARD_RELOAD: ${error.message}`);
      }
      promptBox = await waitFor(findAffiliateAiPromptBox, 15000, 200, 'kotak prompt affiliate setelah dibersihkan');
      await selectVidsRatio(ratio, taskId);
      if (!reuseImages && requestedImages.length > 0) {
        await attachImagesToVids(requestedImages, promptBox, taskId, true);
        lastAffiliateImagesKey = affiliateImagesKey(requestedImages);
      }
      await typePromptWithMentions(promptBox, prompt, taskId);
      createButton = await waitFor(findCreateButton, 30000, 250, 'tombol Buat / Kirim');
    } else {
      // Pertahankan alur video biasa yang lama; perubahan affiliate tidak boleh masuk ke jalur ini.
      if (Array.isArray(images) && images.length > 0) await attachImagesToVids(images, promptBox, taskId);
      try {
        const isFollowUpVideo = !/_0$/.test(String(taskId || ''));
        await typePromptWithMentions(promptBox, prompt, taskId, isFollowUpVideo);
      } catch (error) {
        if (/STANDARD_PROMPT_(?:CLEANUP|INPUT)_FAILED/i.test(error.message)) {
          await chrome.runtime.sendMessage({ type: 'HARD_RELOAD_AND_RETRY', taskId, error: error.message });
          throw new Error(`RETRY_AFTER_HARD_RELOAD: ${error.message}`);
        }
        throw error;
      }
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

  function findStandardStartupDialogCloseButton() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'));
    const dialog = dialogs.find(element => {
      if (!isVisible(element)) return false;
      const text = String(element.textContent || '').toLowerCase();
      return text.includes('ayo mulai berkreasi') ||
        (text.includes('buat video ai') && text.includes('video kosong'));
    });
    if (!dialog) return null;

    const controls = Array.from(dialog.querySelectorAll('button, [role="button"], [aria-label], [title]'))
      .filter(isVisible);
    const labelledClose = controls.find(control => {
      const label = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''}`.toLowerCase();
      return /(?:tutup|close)/.test(label);
    });
    if (labelledClose) return labelledClose;

    const dialogRect = dialog.getBoundingClientRect();
    return controls.find(control => {
      const rect = control.getBoundingClientRect();
      const right = Number.isFinite(rect.right) ? rect.right : rect.left + rect.width;
      return rect.width <= 64 && rect.height <= 64 &&
        right >= dialogRect.left + dialogRect.width - 96 &&
        rect.top <= dialogRect.top + 96;
    }) || null;
  }

  async function closeStandardStartupDialog(taskId) {
    const closeButton = findStandardStartupDialogCloseButton();
    if (!closeButton) return false;
    try {
      await trustedClick(closeButton, taskId, 'Menutup dialog awal Google Vids');
    } catch (_) {
      simulateClick(closeButton);
    }
    await waitFor(() => findStandardStartupDialogCloseButton() ? null : true, 5000, 150, 'dialog awal Google Vids tertutup');
    return true;
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
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const semanticPrompt = ['deskripsikan', 'perintah', 'prompt', 'video']
        .some(word => aria.includes(word) || placeholder.includes(word));
      if (semanticPrompt) return true;
      const panel = el.closest?.('[role="complementary"]') || el.parentElement;
      const panelText = (panel?.textContent || '').toLowerCase();
      return panelText.includes('buat') || panelText.includes('animasi');
    }) || null;
  }

  function findVideoAiButton() {
    // 1. Target exact Google Vids element ID from DevTools
    const exactId = document.getElementById('content-library-rail-video-generation-element');
    if (exactId && isVisible(exactId)) return exactId;

    // 2. Target exact data-tooltip or aria-label
    const byAttr = document.querySelector(
      '[data-tooltip="Buat klip video AI"], [aria-label="Buat klip video AI"], [id*="video-generation"]'
    );
    if (byAttr && isVisible(byAttr)) return byAttr;

    // 3. Target exact Google Vids video-generation icon from DevTools
    const icon = document.querySelector('.docs-icon-video-generation-20, [class*="video-generation"]');
    if (icon && isVisible(icon)) {
      return icon.closest('#content-library-rail-video-generation-element') ||
             icon.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box') ||
             icon.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box') ||
             icon;
    }

    // 4. Target exact label element
    const labels = Array.from(document.querySelectorAll('.appsSketchyContentLibraryRailToolbarButtonLabelRefreshed'));
    const label = labels.find(l => isVisible(l) && (l.textContent || '').trim().toLowerCase() === 'video ai');
    if (label) {
      return label.closest('#content-library-rail-video-generation-element') ||
             label.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box') ||
             label.closest('.appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box') ||
             label;
    }

    // 5. Any toolbar button with class appsSketchyContentLibraryRailToolbarButton
    const outerBoxes = Array.from(document.querySelectorAll('.appsSketchyContentLibraryRailToolbarButtonRefreshed-outer-box, .appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box'));
    const box = outerBoxes.find(b => isVisible(b) && (b.textContent || '').toLowerCase().includes('video ai'));
    if (box) return box;

    // 6. Fallback search across all buttons and clickable divs
    const candidates = Array.from(document.querySelectorAll(
      'button, [role="button"], [role="tab"], [role="menuitem"], div[tabindex], div[aria-label], span[aria-label], div, span'
    ));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (el.getAttribute('data-tooltip') || el.getAttribute('title') || '').toLowerCase();
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();

      if (aria === 'video ai' || aria.includes('video ai') || aria.includes('buat klip video ai') ||
          tooltip === 'video ai' || tooltip.includes('video ai') || tooltip.includes('buat klip video ai') ||
          text === 'video ai' || text.startsWith('video ai')) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.width < 250 && rect.height > 0 && rect.height < 250;
      }
      return false;
    });
  }

  function findCreateButton() {
    // Tombol generate (biru bulat arrow-up) = IconButtonFilled.
    // Struktur: button#elptr_NNN > [span.icon-slot, div.icon-button__touch]
    // Strategi: cari dari bawah (div touch layer) → naik ke button parent.

    const isBuatTooltip = el => {
      const t = (el?.textContent || '').trim().toLowerCase();
      return t === 'buat' || t === 'kirim';
    };
    const notTambahkan = btn => {
      const text = (btn.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      return text !== 'tambahkan' && !text.startsWith('tambah');
    };

    // --- Pass 1: cari div[class*="icon-button__touch"] → closest button ---
    // ini paling spesifik karena hanya IconButtonFilled yang punya div touch layer
    const touchDivs = Array.from(document.querySelectorAll('div[class*="icon-button__touch"]'));
    for (const div of touchDivs) {
      if (typeof div.closest !== 'function') continue;   // guard: mock DOM mungkin tidak punya closest()
      const btn = div.closest('button, [role="button"]');
      if (!btn || !isVisible(btn) || btn.disabled) continue;
      if (btn.getAttribute('role') === 'tab') continue;
      if (!notTambahkan(btn)) continue;

      // Verifikasi: tooltip via aria-describedby
      const tipId = btn.getAttribute('aria-describedby');
      if (tipId) {
        const tipEl = document.getElementById(tipId);
        if (isBuatTooltip(tipEl)) return btn;
      }
      // Verifikasi: tooltip sibling dalam parent
      const parent = btn.parentElement;
      if (parent) {
        const tip = parent.querySelector('[role="tooltip"], [class*="Tooltip"]');
        if (isBuatTooltip(tip)) return btn;
        // Coba grandparent juga
        const grandparent = parent.parentElement;
        if (grandparent) {
          const tip2 = grandparent.querySelector('[role="tooltip"], [class*="Tooltip"]');
          if (isBuatTooltip(tip2)) return btn;
        }
      }
      // Kalau tidak ada tooltip, tetap kembalikan sebagai kandidat kuat
      // (asumsi: satu-satunya icon-button yang ada di area ini adalah generate)
      return btn;
    }

    // --- Pass 2: aria-describedby → tooltip text = "Buat" ---
    const allBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of allBtns) {
      if (!isVisible(btn) || btn.disabled) continue;
      if (btn.getAttribute('role') === 'tab') continue;
      if (!notTambahkan(btn)) continue;
      const tipId = btn.getAttribute('aria-describedby');
      if (tipId) {
        const tipEl = document.getElementById(tipId);
        if (isBuatTooltip(tipEl)) return btn;
      }
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const tooltip = (btn.getAttribute('data-tooltip') || '').toLowerCase();
      if (aria === 'buat' || aria === 'kirim' || tooltip === 'buat' || tooltip === 'kirim') return btn;
      if (aria.includes('buat video') || aria.includes('kirim perintah')) return btn;
    }

    // --- Pass 3: textContent persis "buat" (bukan tab/tambahkan) ---
    return allBtns.find(btn => {
      if (!isVisible(btn) || btn.disabled) return false;
      if (btn.getAttribute('role') === 'tab') return false;
      if (!notTambahkan(btn)) return false;
      const text = (btn.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
      return text === 'buat' || text === 'kirim';
    }) || null;
  }


  async function clickCreateAndConfirm(initialButton, taskId, existingUrls) {
    let button = initialButton;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await trustedClick(button, taskId, 'Rendering'); }
      catch (_) { simulateClick(button); }
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

  async function typePromptWithMentions(promptBox, promptText, taskId, standardMode = false) {
    const raw = String(promptText ?? '').trim();
    if (!raw) throw new Error('Prompt kosong.');
    promptBox.focus();

    if (standardMode) {
      const clearCommandButton = findAffiliateComposerClearButton(promptBox);
      if (clearCommandButton) {
        try { await trustedClick(clearCommandButton, taskId, 'Bersihkan Prompt Buat Video'); }
        catch (_) { simulateClick(clearCommandButton); }
        promptBox = await waitFor(() => {
          const current = findAiPromptBox();
          return current && !readPrompt(current) ? current : null;
        }, 5000, 150, 'composer Buat Video kosong setelah Hapus');
        promptBox.focus();
        insertTextAtCaret(promptBox, raw);
        promptBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: raw }));
        promptBox.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: 'TRUSTED_REPLACE_PROMPT', text: raw });
      await new Promise(resolve => setTimeout(resolve, 350));
      if (!response?.success) {
        throw new Error('STANDARD_PROMPT_INPUT_FAILED: Prompt lama Google Vids tidak berhasil diganti.');
      }
      return;
    }
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

  async function clearStandardPromptBox(promptBox) {
    if (!readPrompt(promptBox)) return;
    promptBox.focus();
    const response = await chrome.runtime.sendMessage({ type: 'TRUSTED_CLEAR_PROMPT' });
    await new Promise(resolve => setTimeout(resolve, 350));
    if (response?.success && !readPrompt(promptBox)) return;
    await clearPromptBox(promptBox);
    if (!readPrompt(promptBox)) return;
    throw new Error('STANDARD_PROMPT_CLEANUP_FAILED: Prompt lama Google Vids tidak berhasil dibersihkan.');
  }

  async function insertStandardPrompt(promptBox, promptText) {
    promptBox.focus();
    await chrome.runtime.sendMessage({ type: 'TRUSTED_INSERT_TEXT', text: promptText });
    await new Promise(resolve => setTimeout(resolve, 350));
    if (readPrompt(promptBox) === normalizePrompt(promptText)) return;
    insertTextAtCaret(promptBox, promptText);
    promptBox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
    await new Promise(resolve => setTimeout(resolve, 150));
    if (readPrompt(promptBox) === normalizePrompt(promptText)) return;
    throw new Error('STANDARD_PROMPT_INPUT_FAILED: Prompt baru tidak masuk ke kotak Buat Video.');
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
    const panel = promptBox.closest?.('[role="complementary"]');
    const scope = panel && typeof panel.querySelectorAll === 'function' ? panel : document;
    const candidates = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(button => {
      if (!isVisible(button) || button.disabled) return false;
      if (elementLabel(button) !== 'hapus') return false;
      const rect = button.getBoundingClientRect();
      return rect.top >= promptRect.top;
    });
    return candidates.sort((a, b) =>
      Math.abs(a.getBoundingClientRect().top - promptRect.bottom) -
      Math.abs(b.getBoundingClientRect().top - promptRect.bottom)
    )[0] || null;
  }

  function affiliateImagesKey(images) {
    return JSON.stringify((Array.isArray(images) ? images : []).map(image => [
      String(image?.tag || ''),
      String(image?.name || ''),
      String(image?.dataUrl || '')
    ]));
  }

  function shouldReuseAffiliateImages(cachedKey, images, referencesPresent) {
    return Boolean(referencesPresent) && Array.isArray(images) && images.length > 0 &&
      cachedKey === affiliateImagesKey(images);
  }

  function hasAffiliateComposerReferences(promptBox) {
    const promptRect = promptBox.getBoundingClientRect();
    const panel = promptBox.closest?.('[role="complementary"]');
    const scope = panel && typeof panel.querySelectorAll === 'function' ? panel : document;
    return Array.from(scope.querySelectorAll('[aria-label], [data-tooltip], span')).some(el => {
      if (!isVisible(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.top < promptRect.top) return false;
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
    const targets = [el];
    const inner = el.querySelector?.('.appsSketchyContentLibraryRailToolbarButtonRefreshed-inner-box, [class*="inner-box"], [role="button"], span, div');
    if (inner && inner !== el) targets.push(inner);

    for (const target of targets) {
      target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      try { target.click(); } catch (_) {}
    }
  }

  function normalizePrompt(value) {
    return String(value ?? '').replace(/\u200B/g, '').replace(/\r\n/g, '\n').trim();
  }

  function readPrompt(element) {
    return normalizePrompt('value' in element ? element.value : element.innerText || element.textContent);
  }

  function matchesRatio(text, wanted) {
    const s = String(text || '').toLowerCase();
    if (wanted === 'potret' || wanted === '9:16') {
      return (s.includes('potret') || s.includes('portrait') || s.includes('9:16')) &&
             !s.includes('16:9') && !s.includes('lanskap') && !s.includes('landscape');
    }
    if (wanted === 'persegi' || wanted === '1:1') {
      return (s.includes('persegi') || s.includes('square') || s.includes('1:1')) &&
             !s.includes('16:9') && !s.includes('9:16') && !s.includes('lanskap') && !s.includes('potret');
    }
    if (wanted === 'lanskap' || wanted === '16:9') {
      return (s.includes('lanskap') || s.includes('landscape') || s.includes('16:9')) &&
             !s.includes('9:16') && !s.includes('potret') && !s.includes('portrait');
    }
    return false;
  }

  // Struktur button Google Wiz:
  //   DropdownFilled: button > span[1]:Ripple, span[2]:button__touch (SPAN), span[3]:icon-leading, span[4]:label, span[5]:dropdown
  //   IconButtonFilled: button > span[1]:icon-button__icon-slot, div:icon-button__touch (DIV), span:ripple
  //   → Klik harus ke elemen dengan class *button__touch / *icon-button__touch
  function wizClickTarget(el) {
    if (!el) return el;

    // Prioritas 1: span[class*="button__touch"] — untuk DropdownFilled
    const spanTouch = el.querySelector?.('span[class*="button__touch"]') ||
                      el.querySelector?.('span[class*="ButtonDropdownFilled-button__touch"]') ||
                      el.querySelector?.('span[class*="Filled-button__touch"]') ||
                      el.querySelector?.('span[class*="-button__touch"]');
    if (spanTouch && isVisible(spanTouch)) return spanTouch;

    // Prioritas 2: div[class*="icon-button__touch"] — untuk IconButtonFilled (tombol generate bulat)
    const divTouch = el.querySelector?.('div[class*="icon-button__touch"]') ||
                     el.querySelector?.('div[class*="IconButtonFilled"]') ||
                     el.querySelector?.('div[class*="button__touch"]');
    if (divTouch && isVisible(divTouch)) return divTouch;

    // Prioritas 3: span RippleRipple
    const ripple = el.querySelector?.('span[class*="WizRippleRipple"]') ||
                   el.querySelector?.('span[class*="RippleRipple"]') ||
                   el.querySelector?.('span[class*="Ripple"]');
    if (ripple && isVisible(ripple)) return ripple;

    // Fallback: span ke-2 (button__touch biasanya urutan kedua di DropdownFilled)
    const spans = el.querySelectorAll?.(':scope > span');
    if (spans && spans.length >= 2 && isVisible(spans[1])) return spans[1];

    return el;
  }

  function domClick(el) {
    if (!el) return;
    // Google Wiz buttons: klik harus ke span[3] (ripple/touch layer), bukan button langsung
    const target = wizClickTarget(el);
    try { target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
    try { target.focus(); } catch (_) {}
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    target.dispatchEvent(new PointerEvent('pointerover',  { ...base, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointerenter', { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseover',      { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseenter',     { ...base, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointermove',  { ...base, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mousemove',      { ...base, buttons: 0 }));
    target.dispatchEvent(new PointerEvent('pointerdown',  { ...base, button: 0, buttons: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown',      { ...base, button: 0, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup',    { ...base, button: 0, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup',        { ...base, button: 0, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click',          { ...base, button: 0, buttons: 0 }));
    try { target.click(); } catch (_) {}
    if (target !== el) { try { el.click(); } catch (_) {} }
  }

  async function selectVidsRatio(ratio, taskId) {
    const wanted = ratio === '9:16' ? 'potret' : ratio === '1:1' ? 'persegi' : 'lanskap';
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const active = await waitFor(findRatioButton, 15000, 250, 'tombol rasio aspek');
      if (isRatioSelected(wanted)) {
        console.log(`[Content] Rasio ${ratio} (${wanted}) sudah terpilih.`);
        return;
      }

      console.log(`[Content] Membuka menu rasio aspek (percobaan ${attempt})...`);

      // Dapatkan koordinat dropdown sebelum attach CDP
      let dropdownCenter = getElementCenter(active);

      // Periksa apakah opsi sudah terlihat (popup sudah terbuka)
      let option = findRatioOption(wanted);

      if (!option) {
        // Strategi utama: gunakan TRUSTED_CLICK_SEQUENCE — satu sesi CDP,
        // klik dropdown lalu klik opsi tanpa detach di tengah.
        // Ini mencegah blur/focus-loss yang menutup popup Google Vids.
        try {
          const optionStage = ratio === '9:16' ? 'Memilih Rasio 9:16' :
                              ratio === '1:1' ? 'Memilih Rasio 1:1' :
                              'Memilih Rasio 16:9';

          await chrome.runtime.sendMessage({
            type: 'TRUSTED_CLICK_SEQUENCE',
            taskId,
            clicks: [
              {
                // Klik 1: Buka dropdown
                x: dropdownCenter.x,
                y: dropdownCenter.y,
                stage: 'Membuka Pilihan Rasio',
                taskId,
                delayAfter: 700  // Tunggu popup muncul
              },
              {
                // Klik 2: Klik opsi (stage akan resolve koordinat opsi dari DOM)
                x: dropdownCenter.x,
                y: dropdownCenter.y,
                stage: optionStage,
                taskId,
                delayAfter: 200
              }
            ]
          });
        } catch (seqErr) {
          // Fallback: domClick biasa jika SEQUENCE gagal
          domClick(active);
          await new Promise(r => setTimeout(r, 600));
          option = findRatioOption(wanted);
          if (option) {
            domClick(option);
          }
        }
      } else {
        // Opsi sudah terlihat — langsung klik opsi saja via sequence
        try {
          const optionStage = ratio === '9:16' ? 'Memilih Rasio 9:16' :
                              ratio === '1:1' ? 'Memilih Rasio 1:1' :
                              'Memilih Rasio 16:9';
          await chrome.runtime.sendMessage({
            type: 'TRUSTED_CLICK_SEQUENCE',
            taskId,
            clicks: [{
              x: getElementCenter(option).x,
              y: getElementCenter(option).y,
              stage: optionStage,
              taskId,
              delayAfter: 200
            }]
          });
        } catch (_) {
          domClick(option);
        }
      }

      try {
        await waitFor(() => isRatioSelected(wanted), 4000, 200, 'konfirmasi rasio ' + ratio);
        console.log(`[Content] Rasio ${ratio} (${wanted}) berhasil dikonfirmasi.`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Rasio ' + ratio + ' tidak berhasil dipilih setelah 3 percobaan.');
  }

  function elementLabel(element) {
    return [element?.textContent, element?.getAttribute?.('aria-label'), element?.getAttribute?.('data-tooltip')]
      .filter(Boolean).join(' ').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function findRatioButton() {
    const promptBox = findAffiliateAiPromptBox() || findAiPromptBox();
    const promptRect = promptBox ? promptBox.getBoundingClientRect() : null;
    const allButtons = Array.from(document.querySelectorAll(
      'button, [role="button"], div[role="button"], div[tabindex]'
    ));

    const dropdowns = allButtons.filter(el => {
      if (!isVisible(el) || el.disabled) return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['option', 'menuitem', 'menuitemradio'].includes(role)) return false;

      const label = elementLabel(el);
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const dataTooltip = (el.getAttribute('data-tooltip') || '').toLowerCase();
      const hasTooltip = Array.from(el.querySelectorAll?.('[role="tooltip"]') || [])
        .some(node => /rasio|aspect/i.test(node.textContent || ''));

      if (hasTooltip || aria.includes('rasio') || aria.includes('aspect') || dataTooltip.includes('rasio') || dataTooltip.includes('aspect')) {
        return true;
      }

      const isRatioName = ['lanskap', 'potret', 'persegi', 'landscape', 'portrait', 'square'].some(r =>
        label === r || label.startsWith(r + ' ') || label.startsWith(r + '\n')
      );
      if (isRatioName) {
        const parentRole = el.parentElement?.getAttribute?.('role') || '';
        if (['menu', 'listbox', 'group'].includes(parentRole)) return false;
        return true;
      }
      return false;
    });

    if (dropdowns.length === 0) {
      return allButtons.find(el => {
        if (!isVisible(el) || el.disabled) return false;
        const l = elementLabel(el);
        return ['lanskap', 'potret', 'persegi'].some(r => l.includes(r));
      }) || null;
    }

    if (promptRect && dropdowns.length > 1) {
      const below = dropdowns.filter(el => el.getBoundingClientRect().top >= promptRect.top);
      if (below.length > 0) return below[0];
    }
    return dropdowns[0];
  }

  function isRatioSelected(wanted) {
    const active = findRatioButton();
    if (active && isVisible(active)) {
      const label = elementLabel(active);
      if (matchesRatio(label, wanted)) return true;
    }
    return Array.from(document.querySelectorAll(
      '[class*="WizButtonDropdownFilled-button"], [class*="ButtonDropdown"], [data-tooltip*="rasio" i], [aria-label*="rasio" i], [data-tooltip*="aspect" i], [aria-label*="aspect" i], button, [role="button"]'
    )).some(el => {
      if (!isVisible(el) || el.disabled) return false;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (['option', 'menuitem', 'menuitemradio'].includes(role)) return false;
      const label = elementLabel(el);
      return label.length < 40 && matchesRatio(label, wanted);
    });
  }

  function findRatioOption(wanted) {
    const ratioBtn = findRatioButton();
    const targetTexts = wanted === 'potret' || wanted === '9:16'
      ? ['potret 9:16', 'potret (9:16)', 'potret']
      : wanted === 'persegi' || wanted === '1:1'
      ? ['persegi 1:1', 'persegi (1:1)', 'persegi']
      : ['lanskap 16:9', 'lanskap (16:9)', 'lanskap'];

    const all = Array.from(document.querySelectorAll(
      'button, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], [role="listitem"], div, span, li'
    ));
    const matched = all.filter(el => {
      if (!isVisible(el)) return false;
      if (ratioBtn && (el === ratioBtn || (typeof ratioBtn.contains === 'function' && ratioBtn.contains(el)))) return false;
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (wanted === 'potret' || wanted === '9:16') {
        return targetTexts.some(t => text === t || text.includes(t)) && !text.includes('lanskap') && !text.includes('16:9');
      }
      if (wanted === 'persegi' || wanted === '1:1') {
        return targetTexts.some(t => text === t || text.includes(t)) && !text.includes('lanskap') && !text.includes('potret');
      }
      if (wanted === 'lanskap' || wanted === '16:9') {
        return targetTexts.some(t => text === t || text.includes(t)) && !text.includes('potret') && !text.includes('9:16');
      }
      return false;
    });

    if (matched.length > 0) {
      return matched[matched.length - 1];
    }
    return null;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = typeof window !== 'undefined' ? window.getComputedStyle?.(element) : null;
    return !style || style.display !== 'none' && style.visibility !== 'hidden';
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
