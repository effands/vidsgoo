const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parsePromptBlocks, inspectVideoFile, resolveVideoTarget } = require('./lib/job-utils');

const app = express();
const PORT = 7890;

app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
const chromeDownloadDir = path.join(os.homedir(), 'Downloads', 'Google_Vids');
app.use('/chrome-downloads', express.static(chromeDownloadDir));
const deleteConfirmationToken = crypto.randomBytes(32).toString('hex');

function isSameOriginDashboardRequest(req) {
  const host = req.get('host') || '';
  if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)) return false;
  const expectedOrigin = `http://${host}`;
  const origin = req.get('origin');
  if (origin) return origin === expectedOrigin;
  return req.get('sec-fetch-site') === 'same-origin' && req.get('x-dashboard-request') === 'Google-Vids-Dashboard';
}

function requireDashboardOrigin(req, res, next) {
  if (!isSameOriginDashboardRequest(req)) {
    return res.status(403).json({ error: 'Mutation hanya diizinkan dari dashboard lokal.' });
  }
  next();
}

function requireDeleteToken(req, res, next) {
  if (req.get('x-delete-confirmation-token') !== deleteConfirmationToken) {
    return res.status(403).json({ error: 'Token konfirmasi hapus tidak valid.' });
  }
  next();
}

function isGoogleVidsUrl(url) {
  return typeof url === 'string' && /^https:\/\/docs\.google\.com\/videos(?:\/|$)/.test(url);
}

app.get('/api/delete-token', requireDashboardOrigin, (req, res) => {
  if (req.get('x-dashboard-request') !== 'Google-Vids-Dashboard') {
    return res.status(403).json({ error: 'Permintaan token tidak valid.' });
  }
  res.json({ token: deleteConfirmationToken });
});

// Endpoint Gallery Video
app.get('/api/gallery', (req, res) => {
  const downloadDir = path.join(__dirname, 'downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const sources = [
    { dir: downloadDir, route: '/downloads', source: 'server', sourceLabel: 'Server' },
    { dir: chromeDownloadDir, route: '/chrome-downloads', source: 'chrome', sourceLabel: 'Chrome' }
  ];
  const videoFiles = [];
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    for (const filename of fs.readdirSync(source.dir)) {
      if (!/\.(mp4|webm)$/i.test(filename)) continue;
      const inspection = inspectVideoFile(path.join(source.dir, filename));
      if (!inspection.valid) continue;
      videoFiles.push({
        filename,
        url: `${source.route}/${encodeURIComponent(filename)}`,
        sizeMB: (inspection.size / (1024 * 1024)).toFixed(2),
        createdAt: inspection.stats.birthtime.toISOString(),
        createdLabel: inspection.stats.birthtime.toLocaleString(),
        source: source.source,
        sourceLabel: source.sourceLabel
      });
    }
  }
  videoFiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(videoFiles);
});

const videoRoots = { server: path.join(__dirname, 'downloads'), chrome: chromeDownloadDir };

app.delete('/api/gallery/:source/:filename', requireDashboardOrigin, requireDeleteToken, (req, res) => {
  try {
    const target = resolveVideoTarget(videoRoots, req.params.source, req.params.filename);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Video tidak ditemukan.' });
    const inspection = inspectVideoFile(target);
    if (!inspection.valid) return res.status(400).json({ error: 'File bukan video galeri yang valid.' });
    fs.unlinkSync(target);
    addLog(`🗑️ Video dihapus | Sumber ${req.params.source} | File ${req.params.filename}`);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/gallery', requireDashboardOrigin, requireDeleteToken, (req, res) => {
  let deleted = 0;
  const failures = [];
  for (const [source, dir] of Object.entries(videoRoots)) {
    if (!fs.existsSync(dir)) continue;
    for (const filename of fs.readdirSync(dir).filter(name => /\.(mp4|webm)$/i.test(name))) {
      try {
        const target = resolveVideoTarget(videoRoots, source, filename);
        if (!inspectVideoFile(target).valid) {
          failures.push({ source, filename, error: 'File bukan video galeri yang valid.' });
          continue;
        }
        fs.unlinkSync(target);
        deleted++;
      } catch (error) {
        failures.push({ source, filename, error: error.message });
      }
    }
  }
  addLog(`🗑️ Hapus semua galeri | ${deleted} file dihapus | ${failures.length} gagal`);
  res.json({ success: failures.length === 0, deleted, failures });
});

// Store active Chrome instances
let chromeInstances = [
  { id: 'chrome1', name: 'Chrome Profile 1 (Port 9222)', port: 9222, status: 'unknown' },
  { id: 'chrome2', name: 'Chrome Profile 2 (Port 9223)', port: 9223, status: 'unknown' },
  { id: 'chrome3', name: 'Chrome Profile 3 (Port 9224)', port: 9224, status: 'unknown' }
];

// Queue jobs storage
let taskQueue = [];
let isProcessing = false;
let activeTaskId = null;
let resetVersion = 0;
let logHistory = [];

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${msg}`;
  logHistory.push(logEntry);
  if (logHistory.length > 100) logHistory.shift();
  console.log(logEntry);
}

// Store active Chrome Extension Agents
let activeExtensions = new Map();

function recoverStaleActiveTask() {
  if (!isProcessing || !activeTaskId) return;
  const task = taskQueue.find(item => item.id === activeTaskId);
  if (!task) {
    isProcessing = false;
    activeTaskId = null;
    return;
  }
  const now = Date.now();
  const stageStartedAt = task.downloadStartedAt || task.submittedAt || task.submittingAt || task.assignedAt || now;
  const limitMs = task.status.startsWith('Processing') ? 60000 :
    task.status === 'Submitting' ? 60000 :
    task.status === 'Rendering' ? 300000 :
    task.status === 'Downloading' ? 360000 : null;
  if (!limitMs || now - stageStartedAt < limitMs) return;
  const stalledAgent = task.assignedAgent;
  task.status = 'Pending (Auto Recovery)';
  task.assignedAgent = null;
  task.recoveredAt = now;
  isProcessing = false;
  activeTaskId = null;
  if (stalledAgent && activeExtensions.has(stalledAgent)) {
    activeExtensions.get(stalledAgent).cooldownUntil = now + 120000;
  }
  addLog(`🛟 AUTO RECOVERY | Task ${task.id} dilepas dari Agent ${stalledAgent || '-'} setelah stage macet`);
  setTimeout(processNextQueue, 500);
}

const recoveryInterval = setInterval(recoverStaleActiveTask, 5000);
recoveryInterval.unref?.();

// Endpoint Extension Register (Support GET & POST)
const handleRegister = (req, res) => {
  try {
    const id = req.query.id || (req.body && req.body.id) || 'ext_' + Math.floor(Math.random() * 10000);
    const name = req.query.name || (req.body && req.body.name) || 'Chrome Extension Agent';
    const existing = activeExtensions.get(id) || {};
    activeExtensions.set(id, { ...existing, id, name, lastSeen: Date.now() });
    res.json({ success: true, id, resetVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/extension/register', handleRegister);
app.post('/api/extension/register', handleRegister);

// Endpoint Extension Fetch Task
app.get('/api/extension/get-task', (req, res) => {
  const { extId } = req.query;
  if (!extId || !activeExtensions.has(extId)) return res.json({ hasTask: false });

  // Update heart beat
  const requestingExtension = activeExtensions.get(extId);
  requestingExtension.lastSeen = Date.now();
  if (requestingExtension.cooldownUntil > Date.now()) {
    return res.json({ hasTask: false, cooldown: true });
  }

  // Jika ada task pending
  const pendingTask = taskQueue.find(t => t.status.startsWith('Pending'));
  if (pendingTask && !isProcessing) {
    isProcessing = true;
    activeTaskId = pendingTask.id;
    pendingTask.status = 'Processing (Via Extension)';
    pendingTask.assignedAgent = extId;
    pendingTask.assignedAt = Date.now();
    addLog(`▶️ ASSIGNED | Task ${pendingTask.id} | Agent ${extId} | Rasio ${pendingTask.ratio} | Prompt "${pendingTask.prompt.replace(/\s+/g, ' ').substring(0, 70)}"`);
    return res.json({ hasTask: true, task: pendingTask });
  }

  res.json({ hasTask: false });
});

app.post('/api/extension/task-submitted', (req, res) => {
  const task = taskQueue.find(t => t.id === req.body.taskId);
  if (task) {
    task.status = 'Rendering';
    task.submittedAt = Date.now();
    addLog(`🎬 RENDERING | Task ${task.id} | Agent ${task.assignedAgent || '-'} | Prompt diterima Google Vids`);
  }
  res.json({ success: true });
});

const lifecycleStages = {
  Submitting: { timestamp: 'submittingAt' },
  Rendering: { timestamp: 'submittedAt' },
  Downloading: { timestamp: 'downloadStartedAt' }
};

app.post('/api/extension/task-progress', (req, res) => {
  const { taskId, extId, stage, details } = req.body || {};
  const lifecycleStage = lifecycleStages[stage];
  if (!lifecycleStage) {
    return res.status(400).json({ error: 'Stage lifecycle tidak valid.' });
  }

  const task = taskQueue.find(t => t.id === taskId);
  if (!task) {
    return res.status(404).json({ error: 'Task tidak ditemukan.' });
  }
  if (task.assignedAgent !== extId || !isProcessing || activeTaskId !== task.id) {
    return res.status(409).json({ error: 'Progress bukan dari assignment aktif.' });
  }

  task.status = stage;
  task[lifecycleStage.timestamp] = Date.now();
  addLog(`🔄 ${stage.toUpperCase()} | Task ${task.id} | Agent ${extId || task.assignedAgent || '-'}${details ? ` | ${details}` : ''}`);
  res.json({ success: true });
});

// Completed hanya setelah Chrome mengonfirmasi file selesai diunduh.
app.post('/api/extension/complete-task', (req, res) => {
  const { taskId, extId, verified, details, filename, sizeBytes } = req.body;
  const task = taskQueue.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'Task tidak ditemukan.' });
  if (task.assignedAgent !== extId) return res.status(409).json({ error: 'Agent tidak cocok dengan assignment task.' });
  if (task.status === 'Completed' || task.status === 'Failed') {
    return res.json({ success: true, alreadyTerminal: true });
  }
  if (verified !== true || typeof filename !== 'string' || !filename.trim() ||
      typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return res.status(400).json({ error: 'Konfirmasi download tidak valid.' });
  }
  if (!isProcessing || activeTaskId !== task.id || !/^(Processing|Submitting|Rendering|Downloading)/.test(task.status)) {
    return res.status(409).json({ error: 'Task bukan assignment aktif.' });
  }
  task.status = 'Completed';
  task.completedAt = Date.now();
  task.file = filename.trim();
  const elapsedSec = task.assignedAt ? ((task.completedAt - task.assignedAt) / 1000).toFixed(1) : '?';
  addLog(`✅ COMPLETED | Task ${task.id} | Agent ${extId} | ${task.file} | ${(sizeBytes / 1048576).toFixed(2)} MB | ${elapsedSec} detik | ${details || ''}`);
  isProcessing = false;
  activeTaskId = null;
  setTimeout(processNextQueue, 500);
  res.json({ success: true });
});

app.post('/api/extension/fail-task', (req, res) => {
  const { taskId, extId, error } = req.body;
  const task = taskQueue.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: 'Task tidak ditemukan.' });
  if (task.assignedAgent !== extId) return res.status(409).json({ error: 'Agent tidak cocok dengan assignment task.' });
  if (task.status === 'Completed' || task.status === 'Failed') {
    return res.json({ success: true, alreadyTerminal: true, retryable: false });
  }
  if (!isProcessing || activeTaskId !== task.id || !/^(Processing|Submitting|Rendering|Downloading)/.test(task.status)) {
    return res.status(409).json({ error: 'Task bukan assignment aktif.' });
  }
  const retryable = /Receiving end does not exist|Could not establish connection/i.test(error || '') ||
    /^(tombol Video AI|kotak prompt Google Vids|tombol Buat).*tidak ditemukan setelah/i.test(error || '');
  task.status = retryable ? 'Pending (Retry Agent)' : 'Failed';
  if (retryable) task.assignedAgent = null;
  isProcessing = false;
  activeTaskId = null;
  if (extId && activeExtensions.has(extId)) {
    activeExtensions.get(extId).cooldownUntil = Date.now() + 120000;
  }
  addLog(retryable
    ? `↪️ RETRY | Task ${taskId || '-'} | Agent ${extId || 'extension'} cooldown 120 detik | ${error}`
    : `❌ FAILED | Task ${taskId || '-'} | Agent ${extId || 'extension'} | ${error || 'Kesalahan tidak diketahui.'}`);
  setTimeout(processNextQueue, 500);
  res.json({ success: true, retryable });
});

// Check Connected Chrome Extension Agents
app.get('/api/chromes', async (req, res) => {
  const connectedAgents = [];
  const now = Date.now();

  activeExtensions.forEach((ext, id) => {
    const isOnline = (now - ext.lastSeen < 60000); // Toleransi 60 detik
    connectedAgents.push({
      id: ext.id,
      name: `Chrome Extension (${ext.id})`,
      port: 'Add-ons Agent',
      status: isOnline ? 'Online' : 'Offline'
    });
  });

  res.json(connectedAgents);
});

// Add Chrome Instance Port
app.post('/api/chromes/add', requireDashboardOrigin, (req, res) => {
  const { name, port } = req.body;
  const p = parseInt(port);
  if (!p) return res.status(400).json({ error: 'Port tidak valid' });

  const id = `chrome_${Date.now()}`;
  chromeInstances.push({ id, name: name || `Chrome Port ${p}`, port: p, status: 'unknown' });
  addLog(`Chrome Profile ditambahkan: ${name} (Port ${p})`);
  res.json({ success: true, instances: chromeInstances });
});

// Get Queue & Logs
app.get('/api/status', (req, res) => {
  res.json({
    queue: taskQueue,
    isProcessing,
    logs: logHistory,
    resetVersion
  });
});

// Clear Task Queue
app.delete('/api/queue/clear', requireDashboardOrigin, (req, res) => {
  taskQueue = [];
  isProcessing = false;
  activeTaskId = null;
  addLog('🗑️ Antrean tugas berhasil dibersihkan.');
  res.json({ success: true });
});

app.post('/api/queue/stop-reset', requireDashboardOrigin, (req, res) => {
  const stoppedAt = Date.now();
  let cancelled = 0;
  for (const task of taskQueue) {
    if (/^(Pending|Processing|Submitting|Rendering|Downloading)/.test(task.status)) {
      task.status = 'Cancelled';
      task.cancelledAt = stoppedAt;
      cancelled++;
    }
  }
  isProcessing = false;
  activeTaskId = null;
  resetVersion++;
  addLog(`⏹️ STOP RESET | ${cancelled} task dibatalkan | Antrean siap digunakan kembali`);
  res.json({ success: true, cancelled, resetVersion });
});

// Add Queue Task (Single or Batch Prompts)
app.post('/api/queue/add', requireDashboardOrigin, (req, res) => {
  const { prompts, url, ratio, targetChrome } = req.body;

  if (!prompts || !prompts.trim()) {
    return res.status(400).json({ error: 'Prompt tidak boleh kosong' });
  }
  if (url && !isGoogleVidsUrl(url)) {
    return res.status(400).json({ error: 'URL task harus berada di Google Vids.' });
  }

  const promptList = parsePromptBlocks(prompts);
  
  promptList.forEach((pText, index) => {
    taskQueue.push({
      id: `task_${Date.now()}_${index}`,
      prompt: pText,
      url: url || '',
      ratio: ratio || '16:9',
      targetChrome: targetChrome || 'auto',
      status: 'Pending',
      createdAt: new Date().toLocaleTimeString(),
      createdTimestamp: Date.now()
    });
  });

  addLog(`📥 Batch diterima | ${promptList.length} task | Rasio ${ratio || '16:9'} | Target ${targetChrome || 'auto'}`);
  
  processNextQueue();

  res.json({ success: true, count: promptList.length, totalQueue: taskQueue.length });
});

// Queue Processor Function (Extension-owned execution and download lifecycle)
async function processNextQueue() {
  if (isProcessing) return;

  const pendingTask = taskQueue.find(t => t.status.startsWith('Pending'));
  if (!pendingTask) {
    isProcessing = false;
    return;
  }

  const now = Date.now();
  const healthyExtension = [...activeExtensions.values()].find(ext =>
    now - ext.lastSeen < 10000 && !(ext.cooldownUntil > now)
  );
  if (healthyExtension) {
    addLog(`⏳ Antrean siap. Menunggu Chrome Extension Agent (${healthyExtension.id}) mengambil tugas...`);
  } else {
    addLog(`⏳ Task ${pendingTask.id} menunggu Chrome Extension Agent yang sehat.`);
  }
}

function startServer(port = PORT) {
  const server = app.listen(port, '127.0.0.1', () => {
    addLog(`Google Vids Multi-Chrome Manager berjalan di http://127.0.0.1:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[!] Error: Port ${port} sedang dipakai oleh proses Node sebelumnya.`);
      console.error(`[!] Solusi: Tutup jendela CMD server yang lama terlebih dahulu, lalu buka kembali shortcut desktop.\n`);
    } else {
      console.error(err);
    }
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { app, startServer };
