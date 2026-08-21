const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { parsePromptBlocks, inspectVideoFile, resolveVideoTarget } = require('./lib/job-utils');

const app = express();
const PORT = 7890;

app.use(express.json({ limit: '50mb', strict: false }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

function scanVideosRecursively(baseDir, relativePrefix = '') {
  const currentDir = path.join(baseDir, relativePrefix);
  if (!fs.existsSync(currentDir)) return [];
  const results = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relativePrefix ? path.join(relativePrefix, entry.name) : entry.name;
    const fullPath = path.join(baseDir, relPath);
    if (entry.isDirectory()) {
      results.push(...scanVideosRecursively(baseDir, relPath));
    } else if (entry.isFile() && /\.(mp4|webm)$/i.test(entry.name)) {
      const inspection = inspectVideoFile(fullPath);
      if (inspection.valid) {
        const category = relativePrefix ? relativePrefix.replace(/\\/g, '/') : 'Umum';
        const normalizedRelPath = relPath.replace(/\\/g, '/');
        results.push({
          filename: entry.name,
          relativePath: normalizedRelPath,
          category,
          fullPath,
          sizeMB: (inspection.size / (1024 * 1024)).toFixed(2),
          createdAt: inspection.stats.birthtime.toISOString(),
          createdLabel: inspection.stats.birthtime.toLocaleString(),
        });
      }
    }
  }
  return results;
}

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
    const scanned = scanVideosRecursively(source.dir);
    for (const item of scanned) {
      videoFiles.push({
        filename: item.filename,
        relativePath: item.relativePath,
        category: item.category,
        url: `${source.route}/${item.relativePath.split('/').map(encodeURIComponent).join('/')}`,
        sizeMB: item.sizeMB,
        createdAt: item.createdAt,
        createdLabel: item.createdLabel,
        source: source.source,
        sourceLabel: source.sourceLabel
      });
    }
  }
  videoFiles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(videoFiles);
});

const videoRoots = { server: path.join(__dirname, 'downloads'), chrome: chromeDownloadDir };

const handleDeleteVideo = (req, res) => {
  try {
    const rawPath = req.params[0] || req.params.filename;
    const target = resolveVideoTarget(videoRoots, req.params.source, rawPath);
    if (!fs.existsSync(target)) return res.status(404).json({ error: 'Video tidak ditemukan.' });
    const inspection = inspectVideoFile(target);
    if (!inspection.valid) return res.status(400).json({ error: 'File bukan video galeri yang valid.' });
    fs.unlinkSync(target);
    addLog(`🗑️ Video dihapus | Sumber ${req.params.source} | File ${rawPath}`);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

app.delete('/api/gallery/:source/:filename(*)', requireDashboardOrigin, requireDeleteToken, handleDeleteVideo);

app.delete('/api/gallery', requireDashboardOrigin, requireDeleteToken, (req, res) => {
  let deleted = 0;
  const failures = [];
  for (const [source, dir] of Object.entries(videoRoots)) {
    if (!fs.existsSync(dir)) continue;
    const scanned = scanVideosRecursively(dir);
    for (const item of scanned) {
      try {
        const target = resolveVideoTarget(videoRoots, source, item.relativePath);
        if (!inspectVideoFile(target).valid) {
          failures.push({ source, filename: item.relativePath, error: 'File bukan video galeri yang valid.' });
          continue;
        }
        fs.unlinkSync(target);
        deleted++;
      } catch (error) {
        failures.push({ source, filename: item.relativePath, error: error.message });
      }
    }
  }
  addLog(`🗑️ Hapus semua galeri | ${deleted} file dihapus | ${failures.length} gagal`);
  res.json({ success: failures.length === 0, deleted, failures });
});

const { exec } = require('child_process');

app.post('/api/gallery/open-folder', requireDashboardOrigin, (req, res) => {
  try {
    const { category } = req.body || {};
    let targetDir = chromeDownloadDir;
    if (category && category !== 'ALL' && category !== 'Umum') {
      const safeCat = String(category).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
      const subDir = path.join(chromeDownloadDir, safeCat);
      if (fs.existsSync(subDir)) targetDir = subDir;
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (process.platform === 'win32') {
      exec(`explorer.exe "${targetDir}"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${targetDir}"`);
    } else {
      exec(`xdg-open "${targetDir}"`);
    }
    res.json({ success: true, path: targetDir });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
let terminalHeartbeatActive = false;
let terminalHeartbeatTimer = null;

function formatUptime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs}s`;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startTerminalHeartbeat() {
  if (!process.stdout.isTTY || terminalHeartbeatActive) return;
  terminalHeartbeatActive = true;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const wave = [
    '[ ▰▱▱▱▱ ]',
    '[ ▰▰▱▱▱ ]',
    '[ ▰▰▰▱▱ ]',
    '[ ▰▰▰▰▱ ]',
    '[ ▰▰▰▰▰ ]',
    '[ ▱▰▰▰▰ ]',
    '[ ▱▱▰▰▰ ]',
    '[ ▱▱▱▰▰ ]',
    '[ ▱▱▱▱▰ ]',
    '[ ▱▱▱▱▱ ]'
  ];
  let step = 0;
  const startTime = Date.now();

  terminalHeartbeatTimer = setInterval(() => {
    const f = frames[step % frames.length];
    const w = wave[step % wave.length];
    step++;

    const now = Date.now();
    let onlineExtCount = 0;
    for (const ext of activeExtensions.values()) {
      if (now - ext.lastSeen < 10000 && !(ext.cooldownUntil > now)) onlineExtCount++;
    }
    const pendingCount = taskQueue.filter(t => t.status.startsWith('Pending') || t.status.startsWith('Processing') || t.status === 'Submitting' || t.status === 'Rendering' || t.status === 'Downloading').length;
    const uptimeStr = formatUptime(Math.floor((now - startTime) / 1000));

    const statusText = isProcessing ? '\x1b[33m⚡ SIBUK (Proses Task)\x1b[0m' : '\x1b[32m✔ STANDBY\x1b[0m';
    const line = `\r\x1b[36m${f}\x1b[0m [VIDS GOO] \x1b[35m${w}\x1b[0m ${statusText} \x1b[90m|\x1b[0m Fleet: \x1b[1m${onlineExtCount}\x1b[0m Online \x1b[90m|\x1b[0m Task: \x1b[1m${pendingCount}\x1b[0m \x1b[90m|\x1b[0m Uptime: \x1b[90m${uptimeStr}\x1b[0m `;

    process.stdout.write(line);
  }, 120);

  if (terminalHeartbeatTimer && typeof terminalHeartbeatTimer.unref === 'function') {
    terminalHeartbeatTimer.unref();
  }
}

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${msg}`;
  logHistory.push(logEntry);
  if (logHistory.length > 100) logHistory.shift();
  if (terminalHeartbeatActive && process.stdout.isTTY) {
    process.stdout.write('\r\x1b[K');
  }
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
    activeExtensions.get(stalledAgent).cooldownUntil = now;
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
    activeExtensions.get(extId).cooldownUntil = Date.now();
  }
  addLog(retryable
    ? `↪️ RETRY LANGSUNG | Task ${taskId || '-'} | Agent ${extId || 'extension'} | ${error}`
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
  const { prompts, url, ratio, targetChrome, folder, images, mode } = req.body;

  if (!prompts || !prompts.trim()) {
    return res.status(400).json({ error: 'Prompt tidak boleh kosong' });
  }
  if (url && !isGoogleVidsUrl(url)) {
    return res.status(400).json({ error: 'URL task harus berada di Google Vids.' });
  }

  const promptList = parsePromptBlocks(prompts);
  const sanitizedFolder = String(folder || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
  const safeImages = Array.isArray(images) ? images.slice(0, 3) : [];
  
  promptList.forEach((pText, index) => {
    taskQueue.push({
      id: `task_${Date.now()}_${index}`,
      prompt: pText,
      url: url || '',
      ratio: ratio || '16:9',
      targetChrome: targetChrome || 'auto',
      folder: sanitizedFolder,
      images: safeImages,
      mode: mode || 'standard',
      status: 'Pending',
      createdAt: new Date().toLocaleTimeString(),
      createdTimestamp: Date.now()
    });
  });

  const folderLog = sanitizedFolder ? ` | Folder "${sanitizedFolder}"` : '';
  const modeLog = mode === 'affiliate' ? ' | 🛍️ Mode Affiliate' : '';
  const imageLog = safeImages.length > 0 ? ` | ${safeImages.length} Media` : '';
  addLog(`📥 Batch diterima | ${promptList.length} task | Rasio ${ratio || '16:9'} | Target ${targetChrome || 'auto'}${folderLog}${modeLog}${imageLog}`);
  
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

function printBanner(port = PORT) {
  if (!process.stdout.isTTY) return;
  console.log(`
\x1b[36m  ██╗   ██╗██╗██████╗ ███████╗     ██████╗  ██████╗  ██████╗ 
  ██║   ██║██║██╔══██╗██╔════╝    ██╔════╝ ██╔═══██╗██╔═══██╗
  ██║   ██║██║██║  ██║███████╗    ██║  ███╗██║   ██║██║   ██║
  ╚██╗ ██╔╝██║██║  ██║╚════██║    ██║   ██║██║   ██║██║   ██║
   ╚████╔╝ ██║██████╔╝███████║    ╚██████╔╝╚██████╔╝╚██████╔╝
    ╚═══╝  ╚═╝╚═════╝ ╚══════╝     ╚═════╝  ╚═════╝  ╚═════╝\x1b[0m

\x1b[90m  ===========================================================\x1b[0m
\x1b[1;37m     GOOGLE VIDS AUTOMATION STUDIO - MULTI-CHROME FLEET\x1b[0m
\x1b[90m  ===========================================================\x1b[0m

  \x1b[32m[+]\x1b[0m Web Dashboard : \x1b[36mhttp://127.0.0.1:${port}\x1b[0m
  \x1b[33m[!]\x1b[0m Penopang Server: Jangan tutup jendela ini saat otomasi aktif.
\x1b[90m  ===========================================================\x1b[0m
`);
}

function startServer(port = PORT) {
  printBanner(port);
  const server = app.listen(port, '127.0.0.1', () => {
    addLog(`Google Vids Multi-Chrome Manager berjalan di http://127.0.0.1:${port}`);
    startTerminalHeartbeat();
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
