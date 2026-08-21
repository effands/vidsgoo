const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const { app } = require('../server');
let listener;
let baseUrl;
let dashboardOrigin;

test.before(async () => {
  await new Promise(resolve => {
    listener = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  baseUrl = `http://127.0.0.1:${port}`;
  dashboardOrigin = baseUrl;
});

test.after(async () => {
  if (listener) {
    listener.closeAllConnections?.();
    await new Promise(resolve => listener.close(resolve));
  }
});

async function api(pathname, { method = 'GET', origin, headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await response.text();
  if (text) data = JSON.parse(text);
  return { response, data };
}

async function getDeleteToken() {
  const { response, data } = await api('/api/delete-token', {
    origin: dashboardOrigin,
    headers: { 'X-Dashboard-Request': 'Google-Vids-Dashboard' }
  });
  assert.equal(response.status, 200);
  assert.ok(data.token);
  return data.token;
}

test('server can be imported as an Express app without starting its listener', () => {
  const script = "const loaded = require('./server'); process.exit(loaded.app && typeof loaded.app.listen === 'function' ? 0 : 2);";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 2000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || `exit ${result.status}`);
});

test('delete token is same-origin only and both delete routes reject missing or wrong tokens', async () => {
  const rebound = await fetch(`${baseUrl}/api/delete-token`, {
    headers: {
      Host: 'evil.example',
      Origin: 'http://evil.example',
      'X-Dashboard-Request': 'Google-Vids-Dashboard'
    }
  });
  assert.equal(rebound.status, 403);

  const evilToken = await api('/api/delete-token', {
    origin: 'https://evil.example',
    headers: { 'X-Dashboard-Request': 'Google-Vids-Dashboard' }
  });
  assert.equal(evilToken.response.status, 403);

  const token = await getDeleteToken();
  const noToken = await api('/api/gallery/server/anything.mp4', { method: 'DELETE', origin: dashboardOrigin });
  assert.equal(noToken.response.status, 403);
  const wrongToken = await api('/api/gallery/server/anything.mp4', {
    method: 'DELETE',
    origin: dashboardOrigin,
    headers: { 'X-Delete-Confirmation-Token': 'wrong' }
  });
  assert.equal(wrongToken.response.status, 403);
  const wrongTokenDeleteAll = await api('/api/gallery', {
    method: 'DELETE',
    origin: dashboardOrigin,
    headers: { 'X-Delete-Confirmation-Token': 'wrong' }
  });
  assert.equal(wrongTokenDeleteAll.response.status, 403);
  assert.notEqual(token, 'wrong');
  assert.notEqual(evilToken.response.headers.get('access-control-allow-origin'), '*');
});

test('gallery deletion refuses invalid files and only removes a validated fixture video', async () => {
  const token = await getDeleteToken();
  const unique = `${process.pid}-${Date.now()}`;
  const invalidName = `final-fix-invalid-${unique}.mp4`;
  const validName = `final-fix-valid-${unique}.mp4`;
  const invalidPath = path.join(root, 'downloads', invalidName);
  const validPath = path.join(root, 'downloads', validName);
  fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
  fs.writeFileSync(invalidPath, Buffer.from('not a video'));
  fs.writeFileSync(validPath, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]));

  try {
    const invalid = await api(`/api/gallery/server/${encodeURIComponent(invalidName)}`, {
      method: 'DELETE',
      origin: dashboardOrigin,
      headers: { 'X-Delete-Confirmation-Token': token }
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(fs.existsSync(invalidPath), true);

    const valid = await api(`/api/gallery/server/${encodeURIComponent(validName)}`, {
      method: 'DELETE',
      origin: dashboardOrigin,
      headers: { 'X-Delete-Confirmation-Token': token }
    });
    assert.equal(valid.response.status, 200);
    assert.equal(fs.existsSync(validPath), false);
  } finally {
    if (fs.existsSync(invalidPath)) fs.unlinkSync(invalidPath);
    if (fs.existsSync(validPath)) fs.unlinkSync(validPath);
  }
});

test('dashboard mutations reject foreign origins and queue creation rejects non-Google-Vids URLs', async () => {
  const foreign = await api('/api/queue/add', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { prompts: 'Prompt', url: '' }
  });
  assert.equal(foreign.response.status, 403);

  const invalidUrl = await api('/api/queue/add', {
    method: 'POST',
    origin: dashboardOrigin,
    body: { prompts: 'Prompt', url: 'https://example.com/not-vids' }
  });
  assert.equal(invalidUrl.response.status, 400);
  const status = await api('/api/status');
  assert.equal(status.data.queue.length, 0);
});

test('completion requires a positive verified download and matching active assignment', async () => {
  const add = await api('/api/queue/add', {
    method: 'POST',
    origin: dashboardOrigin,
    body: {
      prompts: ['First', '', 'Second', '', 'Third', '', 'Fourth'].join('\n'),
      url: '',
      ratio: '16:9'
    }
  });
  assert.equal(add.response.status, 200);
  for (const extId of ['ext_a', 'ext_b', 'ext_c', 'ext_d']) {
    const registered = await api(`/api/extension/register?id=${extId}`);
    assert.equal(registered.response.status, 200);
  }

  const assignedA = await api('/api/extension/get-task?extId=ext_a');
  assert.equal(assignedA.data.hasTask, true);
  const firstId = assignedA.data.task.id;
  const baseCompletion = { taskId: firstId, extId: 'ext_a', verified: true, filename: 'video.mp4', sizeBytes: 1024 };
  const invalidCompletions = [
    { ...baseCompletion, verified: false },
    { ...baseCompletion, filename: '   ' },
    { ...baseCompletion, sizeBytes: 0 },
    { ...baseCompletion, extId: 'ext_b' }
  ];
  for (const payload of invalidCompletions) {
    const invalid = await api('/api/extension/complete-task', { method: 'POST', body: payload });
    assert.ok([400, 409].includes(invalid.response.status));
  }
  const beforeComplete = await api('/api/status');
  assert.equal(beforeComplete.data.isProcessing, true);
  assert.match(beforeComplete.data.queue.find(task => task.id === firstId).status, /Processing/);

  const concurrent = await Promise.all([
    api('/api/extension/complete-task', { method: 'POST', body: baseCompletion }),
    api('/api/extension/complete-task', { method: 'POST', body: baseCompletion })
  ]);
  assert.deepEqual(concurrent.map(result => result.response.status), [200, 200]);
  assert.equal(concurrent.filter(result => result.data.alreadyTerminal === true).length, 1);

  const assignedB = await api('/api/extension/get-task?extId=ext_b');
  assert.equal(assignedB.data.hasTask, true);
  const secondId = assignedB.data.task.id;
  const staleComplete = await api('/api/extension/complete-task', { method: 'POST', body: baseCompletion });
  assert.equal(staleComplete.data.alreadyTerminal, true);
  const unknownComplete = await api('/api/extension/complete-task', {
    method: 'POST',
    body: { ...baseCompletion, taskId: 'missing-task', extId: 'ext_b' }
  });
  assert.equal(unknownComplete.response.status, 404);
  const stillBusy = await api('/api/extension/get-task?extId=ext_c');
  assert.equal(stillBusy.data.hasTask, false);
  const status = await api('/api/status');
  assert.equal(status.data.isProcessing, true);
  assert.match(status.data.queue.find(task => task.id === secondId).status, /Processing/);
});

test('failure is terminal for render timeout, retryable for UI lookup, and idempotent when stale', async () => {
  const statusBefore = await api('/api/status');
  const second = statusBefore.data.queue.find(task => task.assignedAgent === 'ext_b');
  assert.ok(second);
  const wrongAgent = await api('/api/extension/fail-task', {
    method: 'POST',
    body: { taskId: second.id, extId: 'ext_c', error: 'video hasil render tidak ditemukan setelah 240 detik.' }
  });
  assert.equal(wrongAgent.response.status, 409);

  const renderTimeout = await api('/api/extension/fail-task', {
    method: 'POST',
    body: { taskId: second.id, extId: 'ext_b', error: 'video hasil render tidak ditemukan setelah 240 detik.' }
  });
  assert.equal(renderTimeout.response.status, 200);
  assert.equal(renderTimeout.data.retryable, false);

  const assignedC = await api('/api/extension/get-task?extId=ext_c');
  assert.equal(assignedC.data.hasTask, true);
  const thirdId = assignedC.data.task.id;
  const staleFailure = await api('/api/extension/fail-task', {
    method: 'POST',
    body: { taskId: second.id, extId: 'ext_b', error: 'same stale failure' }
  });
  assert.equal(staleFailure.data.alreadyTerminal, true);
  const stillBusy = await api('/api/extension/get-task?extId=ext_d');
  assert.equal(stillBusy.data.hasTask, false);

  const uiMissing = await api('/api/extension/fail-task', {
    method: 'POST',
    body: { taskId: thirdId, extId: 'ext_c', error: 'tombol Buat tidak ditemukan setelah 30 detik.' }
  });
  assert.equal(uiMissing.response.status, 200);
  assert.equal(uiMissing.data.retryable, true);
  const reassigned = await api('/api/extension/get-task?extId=ext_d');
  assert.equal(reassigned.data.hasTask, true);
  assert.equal(reassigned.data.task.id, thirdId);

  const cleanupFailure = await api('/api/extension/fail-task', {
    method: 'POST',
    body: { taskId: thirdId, extId: 'ext_d', error: 'video hasil render tidak ditemukan setelah 240 detik.' }
  });
  assert.equal(cleanupFailure.response.status, 200);
});
