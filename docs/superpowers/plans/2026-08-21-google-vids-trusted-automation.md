# Google Vids Trusted Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membuat extension Google Vids menghasilkan dan mengunduh video secara otomatis menggunakan trusted Chrome DevTools input, lalu menampilkan MP4 valid yang playable di galeri dashboard.

**Architecture:** Content script bertanggung jawab menemukan elemen dan koordinatnya, sedangkan background worker menjadi satu-satunya komponen yang berbicara ke server, Chrome Debugger, dan Chrome Downloads. Server menyimpan lifecycle task dan menyajikan galeri dari folder unduhan Chrome serta server.

**Tech Stack:** Node.js 24, Express 4, Chrome Extension Manifest V3, `chrome.debugger`, `chrome.downloads`, HTML/JavaScript dashboard, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-21-google-vids-trusted-automation-design.md`

## Global Constraints

- Debugger hanya boleh attach pada URL yang diawali `https://docs.google.com/videos/`.
- Debugger selalu detach melalui `finally` setelah trusted click.
- Task hanya Completed setelah Chrome Downloads mengirim state `complete`.
- Hasil lama tidak boleh dianggap sebagai hasil task baru.
- Satu prompt bebas multiline; batch hanya dipisahkan `=== PROMPT BARU ===` pada baris tersendiri.
- Tidak membaca cookie, password, history, atau data akun.
- Repository Git tidak tersedia; langkah commit diganti dengan pemeriksaan diff/file dan tes penuh.

---

### Task 1: Trusted Click Background API

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/background.js`
- Test: `test/extension-lifecycle.test.js`

**Interfaces:**
- Consumes: message `{ type: "TRUSTED_CLICK", tabId?: number, x: number, y: number, taskId: string, stage: string }` from content script.
- Produces: response `{ success: true }` or `{ success: false, error: string }`.
- Produces: `trustedClick(tabId, x, y): Promise<void>`.

- [ ] **Step 1: Extend the failing lifecycle test**

```js
assert.ok(manifest.permissions.includes('debugger'));
assert.match(background, /chrome\.debugger\.attach/);
assert.match(background, /Input\.dispatchMouseEvent/);
assert.match(background, /chrome\.debugger\.detach/);
assert.match(background, /docs\.google\.com\/videos/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test test/extension-lifecycle.test.js`

Expected: FAIL because permission and trusted-click implementation are absent.

- [ ] **Step 3: Add the debugger permission**

Add `"debugger"` to `extension/manifest.json` permissions without removing `downloads`, `tabs`, `scripting`, `alarms`, or `storage`.

- [ ] **Step 4: Implement trusted click with URL allowlist and guaranteed detach**

```js
async function trustedClick(tabId, x, y) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith('https://docs.google.com/videos/')) {
    throw new Error('Trusted click ditolak: tab bukan Google Vids.');
  }
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
```

- [ ] **Step 5: Route TRUSTED_CLICK messages and server progress through background**

Resolve `tabId` from `sender.tab.id`, call `trustedClick`, then call `/api/extension/task-progress` with `taskId`, `stage`, and `extId`. Never allow the content script to fetch localhost directly.

- [ ] **Step 6: Verify Task 1**

Run: `node --check extension/background.js && node --test test/extension-lifecycle.test.js`

Expected: syntax valid and all lifecycle tests PASS.

---

### Task 2: Content Script Coordinate Workflow

**Files:**
- Modify: `extension/content.js`
- Test: `test/extension-lifecycle.test.js`

**Interfaces:**
- Consumes: task message `{ type: "EXECUTE_VIDS_AUTOMATION", prompt, ratio, taskId }`.
- Consumes: background response from `TRUSTED_CLICK`.
- Produces: `getElementCenter(element): { x: number, y: number }`.
- Produces: new video URL sent as `DOWNLOAD_VIDEO_FILE`.

- [ ] **Step 1: Add failing assertions for coordinate workflow**

```js
assert.match(content, /getBoundingClientRect/);
assert.match(content, /TRUSTED_CLICK/);
assert.doesNotMatch(content, /fetch\(`?\$?\{?SERVER_URL/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/extension-lifecycle.test.js`

Expected: FAIL because content still clicks DOM elements and fetches localhost.

- [ ] **Step 3: Implement visible element selection and center calculation**

```js
function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return element.offsetParent !== null && rect.width > 0 && rect.height > 0;
}

function getElementCenter(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
```

- [ ] **Step 4: Replace expand and generate `.click()` calls**

For each target, require `isVisible(element)`, calculate its center, and send:

```js
await chrome.runtime.sendMessage({
  type: 'TRUSTED_CLICK',
  taskId,
  stage: 'Submitting',
  ...getElementCenter(button)
});
```

After expanding, wait for an enabled visible button whose accessible label or text is `Buat`. After trusted generate click, wait for a new URL not present in `existingUrls`.

- [ ] **Step 5: Remove direct localhost fetch**

Delete `SERVER_URL` and `/api/extension/task-submitted` fetch from content script. Progress is acknowledged by background as part of `TRUSTED_CLICK`.

- [ ] **Step 6: Verify Task 2**

Run: `node --check extension/content.js && node --test test/extension-lifecycle.test.js`

Expected: syntax valid and lifecycle tests PASS.

---

### Task 3: Server Lifecycle and Retry Semantics

**Files:**
- Modify: `server.js`
- Create: `test/server-lifecycle.test.js`

**Interfaces:**
- Consumes: `POST /api/extension/task-progress` with `{ taskId, extId, stage, details? }`.
- Produces: queue status with `status`, `assignedAt`, `submittedAt`, `downloadStartedAt`, and `completedAt` where applicable.
- Consumes: complete/failure messages already defined by background.

- [ ] **Step 1: Write a source-level failing lifecycle test**

```js
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
assert.match(source, /\/api\/extension\/task-progress/);
assert.match(source, /Submitting/);
assert.match(source, /Downloading/);
assert.match(source, /setTimeout\(processNextQueue/);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test test/server-lifecycle.test.js`

Expected: FAIL because the unified progress endpoint is absent.

- [ ] **Step 3: Implement the progress endpoint**

Accept only stages `Submitting`, `Rendering`, and `Downloading`. Update the matching task and timestamps, then append a log containing task ID, agent ID, stage, and details.

- [ ] **Step 4: Ensure every terminal state advances the queue**

Both `/complete-task` and `/fail-task` must set `isProcessing = false` and call `setTimeout(processNextQueue, 500)`. Retryable agent failures keep the task Pending and place that agent on cooldown.

- [ ] **Step 5: Remove the unauthenticated backend video downloader**

Delete `/api/extension/download-video`; authenticated downloads are exclusively handled by `chrome.downloads`.

- [ ] **Step 6: Verify Task 3**

Run: `node --check server.js && node --test test/server-lifecycle.test.js test/batch-and-gallery.test.js`

Expected: syntax valid and all selected tests PASS.

---

### Task 4: End-to-End Verification and Gallery Playback

**Files:**
- Verify: `extension/manifest.json`
- Verify: `extension/background.js`
- Verify: `extension/content.js`
- Verify: `server.js`
- Verify: `public/index.html`

**Interfaces:**
- Consumes dashboard `POST /api/queue/add`.
- Produces MP4 in `%USERPROFILE%/Downloads/Google_Vids`.
- Produces playable gallery URL `/chrome-downloads/<encoded filename>`.

- [ ] **Step 1: Run all automated tests**

Run: `node --check server.js && node --check extension/background.js && node --check extension/content.js && node --test test/dashboard-init.test.js test/extension-lifecycle.test.js test/batch-and-gallery.test.js test/server-lifecycle.test.js`

Expected: exit code 0 and zero failures.

- [ ] **Step 2: Restart only the local server on port 7890**

Resolve the exact listening PID, stop only that PID, and start `node server.js` hidden with working directory `E:\AUTO KLIK\Vids Goo`.

- [ ] **Step 3: Reload the unpacked extension and Google Vids tab**

Reload `Google Vids AI Generator & Downloader` once from `chrome://extensions`, then refresh the target Google Vids tab so the new content script is active.

- [ ] **Step 4: Submit the test prompt**

```powershell
$body = @{ prompts = 'embun pagi di sungai'; ratio = '16:9'; targetChrome = 'auto'; url = '' } | ConvertTo-Json
Invoke-RestMethod 'http://127.0.0.1:7890/api/queue/add' -Method Post -ContentType 'application/json' -Body $body
```

- [ ] **Step 5: Observe lifecycle without manually clicking Google Vids**

Poll `/api/status` until the task reaches Completed or Failed. Confirm logs contain Assigned, Submitting/Rendering, Downloading, and Completed for the same task ID.

- [ ] **Step 6: Verify physical MP4**

Confirm the newest file in `%USERPROFILE%/Downloads/Google_Vids` is larger than 12 bytes and bytes 4-7 equal `ftyp`.

- [ ] **Step 7: Verify gallery HTTP playback**

Call `/api/gallery`, select the matching Chrome-source file, then request it with `Range: bytes=0-1023`. Expected status is 206 and `Content-Type` begins with `video/`.

- [ ] **Step 8: Verify dashboard video element**

Open `http://127.0.0.1:7890`, confirm the new card appears, its `<video>` has `readyState >= 1`, and playback starts without a console error.

- [ ] **Step 9: Record final evidence**

Report task ID, final status, filename, byte size, gallery URL, HTTP range result, and automated test count. Do not claim completion if any item is missing.
