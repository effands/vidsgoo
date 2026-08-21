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
    trustedClick(tabId, message.x, message.y)
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
    let [targetTab] = await chrome.tabs.query({ url: '*://docs.google.com/videos/*' });
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
    if (!String(error.message).includes('Receiving end does not exist')) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await delay(300);
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function trustedClick(tabId, x, y) {
  const tab = await chrome.tabs.get(tabId);
  if (!isGoogleVidsUrl(tab.url)) {
    throw new Error('Trusted click hanya diizinkan pada Google Vids.');
  }

  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, '1.3');
  try {
    const attachedTab = await chrome.tabs.get(tabId);
    if (!isGoogleVidsUrl(attachedTab.url)) {
      throw new Error('Tab berpindah dari Google Vids sebelum trusted click.');
    }
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    });
  } finally {
    await chrome.debugger.detach(debuggee);
  }
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
  if (reportedTaskFailures.has(taskId)) return;
  reportedTaskFailures.add(taskId);
  busy = false;
  currentTaskId = null;
  currentDownloadId = null;
  try {
    await postJson('/api/extension/fail-task', { taskId, extId: instanceId, error });
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
