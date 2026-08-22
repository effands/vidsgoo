# Multi-API-Key Prompt Generator Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan penyimpanan beberapa API key per provider, fallback otomatis lintas key dan provider, serta UI API Key baru yang responsif.

**Architecture:** Browser menyimpan seluruh credential di localStorage dan menyusun kandidat fallback. Generator mengirim satu key per permintaan ke endpoint yang sudah ada, berpindah kandidat setelah kegagalan, dan berhenti pada keberhasilan pertama. Server tetap stateless terhadap API key.

**Tech Stack:** Node.js, Express, JavaScript browser, localStorage, Playwright, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-22-multi-api-key-fallback-design.md`

## Global Constraints

- Mendukung Gemini, DeepSeek, Groq, dan OpenAI.
- API key hanya disimpan pada profil browser lokal dan tidak boleh masuk log atau antrean video.
- Satu permintaan generator hanya membawa satu API key.
- Provider pilihan dicoba pertama, lalu provider lain dalam urutan Gemini, DeepSeek, Groq, OpenAI.
- Tema terang dan gelap harus tetap kontras serta tidak menimbulkan overflow.

---

### Task 1: Penyimpanan Multi-Key dan Penyusunan Kandidat

**Files:**
- Modify: `public/ai-settings.js`
- Modify: `test/ai-settings.test.js`

**Interfaces:**
- Produces: `saveProviderSettings(storage, provider, apiKeys, model)`, `buildFallbackCandidates(settings, preferredProvider)`, `markCredentialResult(storage, provider, credentialId, valid)`.
- Credential shape: `{ id: string, apiKey: string, status: "untested" | "valid" | "failed" }`.

- [ ] **Step 1: Write failing storage migration and fallback-order tests**

```js
assert.deepEqual(loadAiSettings(legacyStorage).providers.gemini.credentials[0].apiKey, 'legacy-key');
assert.deepEqual(buildFallbackCandidates(settings, 'deepseek').map(item => item.provider), ['deepseek', 'deepseek', 'gemini']);
```

- [ ] **Step 2: Run RED test**

Run: `node --test test/ai-settings.test.js`
Expected: FAIL because credential arrays and fallback functions do not exist.

- [ ] **Step 3: Implement schema v2 and migration**

Implement normalized provider records with `model`, `credentials`, and `activeCredentialId`. Deduplicate trimmed keys, ignore empty keys, migrate legacy `apiKey`, and preserve provider selection.

- [ ] **Step 4: Implement deterministic fallback candidate construction**

Return enabled non-empty credentials, preferred provider first, active credential first within that provider, then remaining providers in fixed order.

- [ ] **Step 5: Run GREEN test**

Run: `node --test test/ai-settings.test.js`
Expected: PASS.

### Task 2: Redesign Menu API Key

**Files:**
- Modify: `public/index.html`
- Modify: `test/gallery-and-api-key-ui.test.js`

**Interfaces:**
- Consumes: schema and functions from Task 1.
- Produces DOM containers `#aiProviderTabs`, `#aiCredentialList`, `#addAiCredential`, and `#aiFallbackOrder`.

- [ ] **Step 1: Write failing Playwright assertions**

```js
assert.equal(await page.locator('#aiProviderTabs [data-provider]').count(), 4);
assert.equal(await page.locator('#addAiCredential').count(), 1);
assert.equal(await page.locator('#aiFallbackOrder').count(), 1);
```

- [ ] **Step 2: Run RED UI test**

Run: `node --test test/gallery-and-api-key-ui.test.js`
Expected: FAIL because the redesigned controls do not exist.

- [ ] **Step 3: Replace the details form with provider tabs and credential cards**

Render each credential with masked input, status badge, Test, Tampilkan, and Hapus actions. Keep model selection for the active provider and add a visible Tambah API Key action.

- [ ] **Step 4: Add responsive light/dark styles**

Use existing design tokens. Provider tabs scroll horizontally on narrow screens; credential actions wrap; input remains full width; no horizontal document overflow.

- [ ] **Step 5: Run GREEN UI test**

Run: `node --test test/gallery-and-api-key-ui.test.js`
Expected: PASS.

### Task 3: Automatic Client-Side Fallback

**Files:**
- Modify: `public/index.html`
- Modify: `test/gallery-and-api-key-ui.test.js`
- Modify: `test/ai-settings.test.js`

**Interfaces:**
- Consumes: `buildFallbackCandidates()` and `markCredentialResult()`.
- Produces: browser function `generatePromptsWithFallback(basePayload, candidates, requestFn)` returning the first successful provider response or a sanitized aggregate error.

- [ ] **Step 1: Write failing fallback tests**

```js
const result = await generatePromptsWithFallback(payload, candidates, async candidate => {
  if (candidate.apiKey === 'bad') throw new Error('HTTP 401');
  return { prompts: 'ok', provider: candidate.provider, model: candidate.model };
});
assert.equal(result.prompts, 'ok');
```

- [ ] **Step 2: Run RED fallback test**

Run: `node --test test/ai-settings.test.js test/gallery-and-api-key-ui.test.js`
Expected: FAIL because fallback execution is absent.

- [ ] **Step 3: Implement sequential fallback**

Persist current UI edits, build candidates, send only the active candidate key per request, update status after every attempt, stop on first success, and show provider/key labels without secret fragments.

- [ ] **Step 4: Preserve single-key compatibility**

Verify migrated single keys generate through the same fallback path and existing `/api/ai/generate-affiliate-prompts` request shape remains unchanged.

- [ ] **Step 5: Run GREEN fallback tests**

Run: `node --test test/ai-settings.test.js test/gallery-and-api-key-ui.test.js test/affiliate-module.test.js`
Expected: PASS.

### Task 4: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run the complete suite**

Run: `npm test`
Expected: all tests pass with zero failures.

- [ ] **Step 2: Validate browser JavaScript and diff whitespace**

Run the inline scripts through `node --check -`, then run `git diff --check`.
Expected: exit code 0; line-ending notices are acceptable, syntax or whitespace errors are not.

- [ ] **Step 3: Perform Playwright visual checks**

Open `/#api-keys` in 1440px and 390px viewports for both themes. Verify provider tabs, credential cards, fallback panel, add/test/show/delete controls, and absence of horizontal overflow.
