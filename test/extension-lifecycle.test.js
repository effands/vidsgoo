const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

test('extension menunggu video dan download sebelum melaporkan task selesai', () => {
  const source = [
    fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8')
  ].join('\n');

  assert.match(source, /awaitVideoResult/);
  assert.match(source, /chrome\.downloads\.download/);
  assert.match(source, /state\.current === ['"]complete['"]/);
  assert.match(source, /complete-task/);
  assert.match(source, /fail-task/);
  assert.match(source, /chrome\.runtime\.lastError/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /files:\s*\[['"]content\.js['"]\]/);
});

test('extension mengizinkan host media hasil Google Vids', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes('https://contribution-rt.usercontent.google.com/*'));
});

test('extension menjalankan trusted click DevTools hanya pada Google Vids dan melaporkan progres', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const background = fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8');

  assert.ok(manifest.permissions.includes('debugger'));
  assert.ok(manifest.host_permissions.includes('https://docs.google.com/videos/*'));
  assert.match(background, /async function trustedClick\(tabId, x, y(?:, stage = ['"]{2})?\)/);
  assert.match(background, /resolveClickCenter\(debuggee, stage\)/);
  assert.match(background, /chrome\.tabs\.get\(tabId\)/);
  assert.match(background, /https:\/\/docs\.google\.com\/videos\//);
  assert.match(background, /chrome\.debugger\.attach\([^,]+,\s*['"]1\.3['"]\)/);
  assert.match(background, /Input\.dispatchMouseEvent/);
  assert.match(background, /mouseMoved/);
  assert.match(background, /mousePressed/);
  assert.match(background, /mouseReleased/);
  assert.match(background, /chrome\.debugger\.detach/);
  assert.match(background, /finally\s*\{/);
  assert.match(background, /message\.type === ['"]TRUSTED_CLICK['"]/);
  assert.match(background, /sender(?:\?\.|\.)tab(?:\?\.|\.)id/);
  assert.match(background, /\/api\/extension\/task-progress/);
});

test('content script menghitung koordinat dan meminta trusted click tanpa fetch localhost', () => {
  const content = fs.readFileSync(path.join(root, 'extension', 'content.js'), 'utf8');

  assert.match(content, /function isVisible\(element\)\s*\{/);
  assert.match(content, /element\.getBoundingClientRect\(\)/);
  assert.match(content, /rect\.width <= 0 \|\| rect\.height <= 0/);
  assert.match(content, /style\.display !== ['"]none['"]/);
  assert.match(content, /function getElementCenter\(element\)\s*\{[\s\S]*getBoundingClientRect\(\)[\s\S]*x:\s*rect\.left \+ rect\.width \/ 2[\s\S]*y:\s*rect\.top \+ rect\.height \/ 2/);
  assert.match(content, /type:\s*['"]TRUSTED_CLICK['"][\s\S]*taskId[\s\S]*stage[\s\S]*\.\.\.getElementCenter\(button\)/);
  assert.match(content, /if \(!response\?\.success\) throw new Error\(response\?\.error \|\| ['"]Trusted click gagal\.?['"]\)/);
  assert.doesNotMatch(content, /SERVER_URL|localhost|127\.0\.0\.1|\/api\/extension\/task-submitted/);
});

test('download lifecycle melaporkan Downloading sebelum unduhan dan Completed', async () => {
  const events = [];
  let onMessage;
  let onDownloadChanged;
  const chrome = {
    storage: {
      local: {
        get(_keys, callback) { callback({ ext_id: 'ext_test' }); },
        set() {}
      }
    },
    runtime: {
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    alarms: {
      create() {},
      onAlarm: { addListener() {} }
    },
    downloads: {
      async download() {
        events.push('download');
        return 7;
      },
      async search() {
        return [{ id: 7, state: 'complete', filename: 'C:\\Downloads\\Google_Vids\\video.mp4', totalBytes: 1024 }];
      },
      onChanged: {
        addListener(listener) {
          onDownloadChanged = listener;
          setImmediate(() => onDownloadChanged({ id: 7, state: { current: 'complete' } }));
        },
        removeListener() {}
      }
    }
  };
  const fetch = async (url, options = {}) => {
    if (url.endsWith('/api/extension/task-progress')) {
      events.push(`progress:${JSON.parse(options.body).stage}`);
    }
    if (url.endsWith('/api/extension/complete-task')) events.push('complete');
    return {
      ok: true,
      async json() {
        return url.includes('/api/extension/get-task') ? { hasTask: false } : { success: true };
      }
    };
  };

  vm.runInNewContext(
    fs.readFileSync(path.join(root, 'extension', 'background.js'), 'utf8'),
    { chrome, fetch, console, setImmediate, setInterval() {}, setTimeout, clearTimeout, encodeURIComponent }
  );

  const result = await new Promise(resolve => {
    assert.equal(onMessage({
      type: 'DOWNLOAD_VIDEO_FILE',
      taskId: 'task_regression',
      videoUrl: 'https://contribution-rt.usercontent.google.com/video.mp4'
    }, {}, resolve), true);
  });

  assert.equal(result.success, true);
  assert.deepEqual(events.filter(event => /^(progress:|download|complete)/.test(event)), [
    'progress:Downloading',
    'download',
    'complete'
  ]);
});
