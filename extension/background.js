const SERVER_URL = 'http://127.0.0.1:7890';
let instanceId = null;
let busy = false;
let currentTaskId = null;
let currentDownloadId = null;
let lastResetVersion = 0;
const reportedTaskFailures = new Set();

const instanceReady = new Promise(resolve => {
  chrome.storage.local.get(['ext_id'], (res) => {
    instanceId = res?.ext_id || 'ext_' + Math.random().toString(36).substring(2, 8);
    if (!res?.ext_id) chrome.storage.local.set({ ext_id: instanceId });
    resolve(instanceId);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  if (message.type === 'HEARTBEAT') {
    pollServer();
    sendResponse({ status: 'ack', id: instanceId });
    return false;
  }
  if (message.type === 'DOWNLOAD_VIDEO_FILE' && message.videoUrl) {
    downloadGeneratedVideo(message).then(sendResponse);
    return true;
  }
  if (message.type === 'TRUSTED_CLICK') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted click harus berasal dari tab browser.' });
      return false;
    }
    trustedClick(tabId, message.x, message.y, message.stage)
      .then(async () => {
        await postJson('/api/extension/task-progress', {
          taskId: message.taskId,
          stage: message.stage,
          extId: instanceId
        });
        sendResponse({ success: true });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'TRUSTED_KEY') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted key harus berasal dari tab browser.' });
      return false;
    }
    trustedKey(tabId, message.key || 'Enter')
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'TRUSTED_CLEAR_PROMPT') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted clear harus berasal dari tab browser.' });
      return false;
    }
    trustedClearPrompt(tabId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'TRUSTED_INSERT_TEXT') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted insert harus berasal dari tab browser.' });
      return false;
    }
    trustedInsertText(tabId, message.text || '')
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'TRUSTED_REPLACE_PROMPT') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted replace harus berasal dari tab browser.' });
      return false;
    }
    trustedReplacePrompt(tabId, message.text || '')
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'TRUSTED_CLICK_SEQUENCE') {
    // Melakukan serangkaian klik CDP dalam satu sesi attach/detach.
    // Ini mencegah banner "DevTools disconnected" menutup popup menu.
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Trusted click sequence harus berasal dari tab browser.' });
      return false;
    }
    trustedClickSequence(tabId, message.clicks || [], message.taskId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'HARD_RELOAD_AND_RETRY') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Reload harus berasal dari tab browser.' });
      return false;
    }
    hardReloadAndRetry(tabId, message.taskId, message.error)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (message.type === 'AUTOMATION_FAILED') {
    reportFailure(message.taskId, message.error || 'Automasi Google Vids gagal.');
    return false;
  }
  return false;
});

chrome.alarms.create('vids_keep_alive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vids_keep_alive') pollServer();
});

async function pollServer() {
  try {
    const activeId = await instanceReady;
    const regRes = await fetch(`${SERVER_URL}/api/extension/register?id=${encodeURIComponent(activeId)}&name=Chrome_Agent`);
    if (!regRes.ok) return;
    const registration = await regRes.json();
    if (registration.resetVersion > lastResetVersion) {
      lastResetVersion = registration.resetVersion;
      await stopActiveAutomation();
    }
    if (busy) return;
    const taskRes = await fetch(`${SERVER_URL}/api/extension/get-task?extId=${encodeURIComponent(activeId)}`);
    const data = await taskRes.json();
    if (!data?.hasTask || !data.task) return;
    busy = true;
    currentTaskId = data.task.id;
    await executeTaskOnTab(data.task);
  } catch (err) {
    console.error('[Background] Poll gagal:', err);
  }
}

async function executeTaskOnTab(task) {
  try {
    reportedTaskFailures.delete(task.id);
    if (task.url && !isGoogleVidsUrl(task.url)) {
      throw new Error('URL task harus berada di Google Vids.');
    }
    let tabs = await chrome.tabs.query({ url: '*://docs.google.com/videos/*' });
    let targetTab = null;
    if (task.url) {
      targetTab = tabs.find(t => t.url && t.url.split('#')[0] === task.url.split('#')[0]) || tabs[0];
      if (targetTab && targetTab.url && targetTab.url.split('#')[0] !== task.url.split('#')[0]) {
        await chrome.tabs.update(targetTab.id, { url: task.url, active: true });
        await delay(6000);
      }
    } else {
      targetTab = tabs[0];
    }
    if (!targetTab) {
      targetTab = await chrome.tabs.create({ url: task.url || 'https://docs.google.com/videos/create?usp=vids_alc&authuser=0' });
      await delay(8000);
    }
    await chrome.tabs.update(targetTab.id, { active: true });
    await sendAutomationMessage(targetTab.id, {
      type: 'EXECUTE_VIDS_AUTOMATION',
      prompt: task.prompt,
      ratio: task.ratio,
      taskId: task.id,
      folder: task.folder || '',
      images: task.images || [],
      mode: task.mode || 'standard'
    });
  } catch (err) {
    await reportFailure(task.id, `Gagal mengirim automasi ke tab Google Vids: ${err.message}`);
  }
}

async function sendAutomationMessage(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    const disconnected = /Receiving end does not exist|message channel closed before a response was received/i.test(String(error.message));
    if (!disconnected) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await delay(300);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function trustedClick(tabId, x, y, stage = '') {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) {
    throw new Error('Trusted click hanya diizinkan pada Google Vids.');
  }

  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    // Service worker dapat menerima klik berikutnya ketika sesi milik ekstensi ini
    // masih terpasang. CDP tetap dapat dipakai; jangan jatuh ke klik DOM untrusted.
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) {
      throw error;
    }
  }
  try {
    const attachedTab = await chrome.tabs.get(tabId);
    if (!isGoogleVidsUrl(attachedTab.url)) {
      throw new Error('Tab berpindah dari Google Vids sebelum trusted click.');
    }
    const liveCenter = stage ? await resolveClickCenter(debuggee, stage) : null;
    if (liveCenter) {
      x = liveCenter.x;
      y = liveCenter.y;
    }
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

async function trustedKey(tabId, key = 'Enter') {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Trusted key hanya diizinkan pada Google Vids.');
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) throw error;
  }
  try {
    const keyCodeMap = { Enter: 13, ArrowDown: 40, ArrowUp: 38, Space: 32, Escape: 27 };
    const keyCode = keyCodeMap[key] || (key === 'Enter' ? 13 : 0);
    const params = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

async function trustedClearPrompt(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Trusted clear hanya diizinkan pada Google Vids.');
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) throw error;
  }
  try {
    const send = params => chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', params);
    await send({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await send({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await send({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await send({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    await send({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await send({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

async function trustedInsertText(tabId, text) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Trusted insert hanya diizinkan pada Google Vids.');
  const value = String(text || '');
  if (!value) throw new Error('Teks prompt kosong.');
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) throw error;
  }
  try {
    await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: value });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

async function trustedReplacePrompt(tabId, text) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Trusted replace hanya diizinkan pada Google Vids.');
  const value = String(text || '');
  if (!value) throw new Error('Teks prompt kosong.');
  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) throw error;
  }
  try {
    const send = params => chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', params);
    await send({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 });
    await send({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await send({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
    await send({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 });
    await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: value });
  } finally {
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

// Menjalankan beberapa klik CDP dalam SATU sesi attach/detach.
// Kritis untuk menu popup: CDP detach memicu blur yang menutup popup.
// Dengan attach sekali dan klik semua target tanpa detach di tengah,
// popup tetap terbuka saat klik opsi mendarat.
async function trustedClickSequence(tabId, clicks, taskId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Trusted click sequence hanya diizinkan pada Google Vids.');

  const debuggee = { tabId };
  try {
    await chrome.debugger.attach(debuggee, '1.3');
  } catch (error) {
    if (!/already attached|another debugger is already attached/i.test(String(error?.message || error))) throw error;
  }

  try {
    for (const click of clicks) {
      // Resolve koordinat terbaru dari DOM (opsi mungkin baru muncul)
      let { x, y } = click;
      if (click.stage) {
        const liveCenter = await resolveClickCenter(debuggee, click.stage);
        if (liveCenter) { x = liveCenter.x; y = liveCenter.y; }
      }
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      });
      await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      });

      if (click.taskId && click.stage) {
        await postJson('/api/extension/task-progress', {
          taskId: click.taskId || taskId,
          stage: click.stage,
          extId: instanceId
        }).catch(() => {});
      }

      // Jeda antar klik agar DOM punya waktu merespons (popup muncul, dsb.)
      if (click.delayAfter) {
        await delay(click.delayAfter);
      }
    }
  } finally {
    // Detach HANYA setelah semua klik selesai
    try { await chrome.debugger.detach(debuggee); } catch (_) {}
  }
}

async function hardReloadAndRetry(tabId, taskId, error = '') {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) throw new Error('Hard reload hanya diizinkan pada Google Vids.');
  const result = await reportFailure(taskId, `RETRY_AFTER_HARD_RELOAD: ${error || 'Google Vids perlu dimuat ulang'}`);
  if (result?.retryable !== false) await chrome.tabs.reload(tabId, { bypassCache: true });
}

async function resolveClickCenter(debuggee, stage) {
  const safeStage = JSON.stringify(String(stage || ''));
  const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const stage = ${safeStage}.toLowerCase();
      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const label = el => [el.textContent, el.getAttribute('aria-label'), el.getAttribute('data-tooltip')]
        .filter(Boolean).join(' ').trim().replace(/\\s+/g, ' ').toLowerCase();

      // Untuk button Google Wiz: klik ke span[class*="button__touch"] bukan ke button sendiri
      // Struktur: button > span[1]:Ripple, span[2]:button__touch, span[3]:icon-leading,
      //           span[4]:button__label (V67aGc), span[5]:icon-dropdown
      const wizTouch = btn => {
        if (!btn) return null;
        const t = btn.querySelector('span[class*="button__touch"]') ||
                  btn.querySelector('span[class*="-button__touch"]');
        return (t && visible(t)) ? t : btn;
      };
      const center = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; };

      const controls = [...document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="listitem"],div[tabindex],div[class*="menuitem"],div[class*="MenuItem"],div[class*="item"],li,span,div')].filter(visible);
      let el = null;
      if (stage.includes('membuka panel video ai')) {
        el = document.getElementById('content-library-rail-video-generation-element') ||
             controls.find(x => {
               const id = (x.id || '').toLowerCase();
               const aria = (x.getAttribute('aria-label') || '').toLowerCase();
               const tooltip = (x.getAttribute('data-tooltip') || '').toLowerCase();
               const l = label(x);
               return id.includes('video-generation') ||
                      aria === 'buat klip video ai' || aria.includes('buat klip video ai') ||
                      aria === 'video ai' || aria.includes('video ai') ||
                      tooltip.includes('buat klip video ai') || tooltip.includes('video ai') ||
                      l === 'video ai' || l.includes('video ai') ||
                      (x.querySelector && x.querySelector('.docs-icon-video-generation-20'));
             });
      } else if (stage.includes('bersihkan prompt buat video')) {
        const labels = [...document.querySelectorAll('button span, [role="button"] span')].filter(visible);
        const clearLabel = labels.find(x => label(x) === 'hapus');
        const clearButton = clearLabel?.closest?.('button,[role="button"]');
        el = clearButton && visible(clearButton) ? wizTouch(clearButton) : clearLabel;
      } else if (stage === 'rendering') {
        // Bottom-up: cari div touch layer dulu → naik ke button via closest()
        // Ini cara paling andal karena class IconButtonFilled bisa ada di parent, bukan di <button>
        const isBuatTooltip = t => { const s = (t?.textContent || '').trim().toLowerCase(); return s === 'buat' || s === 'kirim'; };
        const notTambahkan = btn => { const t = (btn.textContent || '').trim().toLowerCase().replace(/\s+/g,' '); return t !== 'tambahkan' && !t.startsWith('tambah'); };

        // Pass 1: div[class*="icon-button__touch"] → closest button → cek tooltip
        const touchDivs = [...document.querySelectorAll('div[class*="icon-button__touch"]')];
        let genBtn = null;
        for (const div of touchDivs) {
          const btn = div.closest('button,[role="button"]');
          if (!btn || !visible(btn) || btn.disabled || btn.getAttribute('role') === 'tab') continue;
          if (!notTambahkan(btn)) continue;
          // Verifikasi via aria-describedby
          const tipId = btn.getAttribute('aria-describedby');
          if (tipId && isBuatTooltip(document.getElementById(tipId))) { genBtn = btn; break; }
          // Verifikasi via sibling/grandparent tooltip
          const par = btn.parentElement;
          if (par) {
            const tip = par.querySelector('[role="tooltip"],[class*="Tooltip"]');
            if (isBuatTooltip(tip)) { genBtn = btn; break; }
            const gpar = par.parentElement;
            if (gpar) {
              const tip2 = gpar.querySelector('[role="tooltip"],[class*="Tooltip"]');
              if (isBuatTooltip(tip2)) { genBtn = btn; break; }
            }
          }
          // Tidak ada tooltip — tetap ambil (kandidat kuat)
          if (!genBtn) genBtn = btn;
        }
        if (!genBtn) {
          // Pass 2: aria/tooltip langsung di button
          const allBtns = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
          for (const btn of allBtns) {
            if (btn.getAttribute('role') === 'tab' || !notTambahkan(btn)) continue;
            const tipId = btn.getAttribute('aria-describedby');
            if (tipId && isBuatTooltip(document.getElementById(tipId))) { genBtn = btn; break; }
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            const tt = (btn.getAttribute('data-tooltip') || '').toLowerCase();
            if (aria === 'buat' || aria === 'kirim' || tt === 'buat' || tt === 'kirim') { genBtn = btn; break; }
          }
        }
        if (genBtn) {
          // Gunakan div touch layer untuk koordinat CDP
          const divT = genBtn.querySelector('div[class*="icon-button__touch"]') || genBtn.querySelector('div[class*="button__touch"]');
          el = (divT && visible(divT)) ? divT : genBtn;
        }

      } else if (stage.includes('form buat') || stage === 'submitting') {
        el = controls.find(x => ['luaskan', 'expand'].includes((x.getAttribute('aria-label') || '').toLowerCase()) || ['luaskan', 'expand'].includes((x.getAttribute('data-tooltip') || '').toLowerCase()));
      } else if (stage.includes('memilih rasio')) {
        // Klik OPSI di popup menu — cari elemen dengan teks yang tepat
        const wanted = stage.includes('9:16') ? 'potret' : stage.includes('1:1') ? 'persegi' : 'lanskap';
        const matchRatio = (t, w) => {
          const s = (t || '').trim().replace(/\\s+/g, ' ').toLowerCase();
          if (w === 'potret') return (s.includes('potret') || s.includes('9:16')) && !s.includes('16:9') && !s.includes('lanskap');
          if (w === 'persegi') return (s.includes('persegi') || s.includes('1:1')) && !s.includes('16:9') && !s.includes('9:16');
          return (s.includes('lanskap') || s.includes('16:9')) && !s.includes('9:16') && !s.includes('potret');
        };
        // Cari di popup menu — prioritaskan role=menuitem/option/listitem
        const menuItems = [...document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"],[role="listitem"],li')].filter(visible);
        el = menuItems.find(x => matchRatio(label(x), wanted));
        if (!el) {
          // Fallback: semua elemen visible yang cocok, ambil yang terdalam (last)
          const all = [...document.querySelectorAll('*')].filter(visible);
          const matched = all.filter(x => matchRatio(x.textContent?.trim().replace(/\\s+/g,' ').toLowerCase(), wanted) && x.children.length === 0);
          el = matched[matched.length - 1] || null;
        }
      } else if (stage.includes('membuka pilihan rasio') || (stage.includes('rasio') && !stage.includes('memilih'))) {
        // Klik DROPDOWN BUTTON — targetkan button__touch span di dalamnya
        const matchAnyRatioName = l => ['lanskap', 'landscape', 'potret', 'portrait', 'persegi', 'square'].some(k => l.includes(k));
        // Cari button yang memiliki label__label span dengan teks ratio
        const ratioBtn = [...document.querySelectorAll('button')].filter(visible).find(btn => {
          const labelSpan = btn.querySelector('span[class*="button__label"],[jsname="V67aGc"]');
          if (labelSpan) return matchAnyRatioName(labelSpan.textContent?.toLowerCase() || '');
          return matchAnyRatioName(label(btn));
        }) || controls.find(x => {
          const l = label(x);
          return (l.includes('rasio') || l.includes('aspect') || matchAnyRatioName(l)) &&
                 (x.className?.includes('Dropdown') || x.getAttribute('aria-haspopup') || l.includes('rasio') || l.includes('aspect'));
        });
        if (ratioBtn) {
          // Kembalikan koordinat button__touch span, bukan button langsung
          el = wizTouch(ratioBtn);
        }
      } else if (stage.includes('tambah gambar')) {
        el = controls.find(x => label(x) === 'bahan');
      }
      if (!el) return null;
      return center(el);
    })()`
  });
  return result?.result?.value || null;
}


async function downloadGeneratedVideo({ videoUrl, taskId, folder }) {
  try {
    await postJson('/api/extension/task-progress', {
      taskId,
      stage: 'Downloading',
      extId: instanceId
    });
    const safeFolder = String(folder || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
    const subFolder = safeFolder ? `Google_Vids/${safeFolder}` : 'Google_Vids';
    const downloadId = await chrome.downloads.download({
      url: videoUrl,
      filename: `${subFolder}/video_${Date.now()}.mp4`,
      conflictAction: 'uniquify',
      saveAs: false
    });
    currentDownloadId = downloadId;
    await waitForDownload(downloadId);
    const [downloadItem] = await chrome.downloads.search({ id: downloadId });
    validateCompletedDownload(downloadItem);
    const fileName = downloadItem.filename.split(/[\\/]/).pop();
    const sizeMB = (downloadItem.totalBytes / 1048576).toFixed(2);
    const storedName = safeFolder ? `${safeFolder}/${fileName}` : fileName;
    await postJson('/api/extension/complete-task', {
      taskId,
      extId: instanceId,
      verified: true,
      filename: storedName,
      sizeBytes: downloadItem.totalBytes,
      details: `Download Chrome selesai | ID ${downloadId} | ${storedName} | ${sizeMB} MB`
    });
    busy = false;
    currentTaskId = null;
    currentDownloadId = null;
    pollServer();
    return { success: true, downloadId };
  } catch (err) {
    await reportFailure(taskId, `Download video gagal: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Download timeout setelah 5 menit.')), 300000);
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (error) reject(error); else resolve();
    }
    function onChanged(delta) {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') finish();
      if (delta.state.current === 'interrupted') finish(new Error(delta.error?.current || 'Download terputus.'));
    }
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId })
      .then(([item]) => {
        if (!item) finish(new Error('Item download tidak ditemukan.'));
        else if (item.state === 'complete') finish();
        else if (item.state === 'interrupted') finish(new Error(item.error || 'Download terputus.'));
      })
      .catch(finish);
  });
}

async function reportFailure(taskId, error) {
  if (reportedTaskFailures.has(taskId)) return null;
  reportedTaskFailures.add(taskId);
  busy = false;
  currentTaskId = null;
  currentDownloadId = null;
  try {
    return await postJson('/api/extension/fail-task', { taskId, extId: instanceId, error });
  } finally {
    pollServer();
  }
}

async function stopActiveAutomation() {
  const taskId = currentTaskId;
  busy = false;
  currentTaskId = null;
  if (currentDownloadId !== null) {
    try { await chrome.downloads.cancel(currentDownloadId); } catch (_) {}
    currentDownloadId = null;
  }
  const tabs = await chrome.tabs.query({ url: '*://docs.google.com/videos/*' });
  await Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTOMATION', taskId }).catch(() => {})));
}

function validateCompletedDownload(item) {
  if (!item) throw new Error('Item download tidak ditemukan.');
  if (item.state !== 'complete') throw new Error('Download belum berstatus complete.');
  if (!item.filename || !item.filename.trim()) throw new Error('Nama file download kosong.');
  if (!Number.isFinite(item.totalBytes) || item.totalBytes <= 0) {
    throw new Error('Ukuran file download harus lebih dari 0 byte.');
  }
}

function isGoogleVidsUrl(url) {
  return typeof url === 'string' && /^https:\/\/docs\.google\.com\/videos(?:\/|$)/.test(url);
}

async function postJson(endpoint, body) {
  const response = await fetch(`${SERVER_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${endpoint} mengembalikan HTTP ${response.status}`);
  return response.json();
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

pollServer();
setInterval(pollServer, 3000);
