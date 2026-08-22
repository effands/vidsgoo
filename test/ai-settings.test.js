const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STORAGE_KEY,
  defaultAiSettings,
  loadAiSettings,
  saveProviderSettings,
  buildFallbackCandidates,
  markCredentialResult,
  generatePromptsWithFallback
} = require('../public/ai-settings');

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

test('pengaturan AI baru memakai Gemini Flash-Lite dengan daftar API key kosong', () => {
  const settings = defaultAiSettings();
  assert.equal(settings.provider, 'gemini');
  assert.deepEqual(settings.providers.gemini, {
    model: 'gemini-3.5-flash-lite', credentials: [], activeCredentialId: ''
  });
  assert.deepEqual(settings.providers.deepseek.credentials, []);
});

test('skema satu API key lama dimigrasikan menjadi credential tanpa kehilangan model', () => {
  const legacy = JSON.stringify({ provider: 'gemini', providers: { gemini: { apiKey: ' legacy-key ', model: 'gemini-3.7-flash' } } });
  const restored = loadAiSettings(memoryStorage({ 'vidsGoo.aiPromptSettings.v1': legacy }));
  assert.equal(restored.providers.gemini.model, 'gemini-3.7-flash');
  assert.deepEqual(restored.providers.gemini.credentials, [{ id: 'gemini-key-1', apiKey: 'legacy-key', status: 'untested' }]);
});

test('beberapa API key disimpan terpisah per provider dan key kosong dibuang', () => {
  const storage = memoryStorage();
  saveProviderSettings(storage, 'gemini', [
    { id: 'g-1', apiKey: ' first ', status: 'valid' },
    { id: 'g-empty', apiKey: ' ', status: 'untested' },
    { id: 'g-2', apiKey: 'second', status: 'failed' }
  ], 'gemini-3.7-flash');
  saveProviderSettings(storage, 'groq', [{ id: 'q-1', apiKey: 'groq-key' }], 'openai/gpt-oss-120b');
  const restored = loadAiSettings(storage);
  assert.equal(restored.provider, 'groq');
  assert.equal(restored.providers.gemini.model, 'gemini-3.7-flash');
  assert.deepEqual(restored.providers.gemini.credentials.map(item => item.apiKey), ['first', 'second']);
  assert.deepEqual(restored.providers.groq.credentials.map(item => item.apiKey), ['groq-key']);
  assert.ok(storage.getItem(STORAGE_KEY));
});

test('fallback mencoba provider pilihan dan key aktif lebih dahulu lalu provider lain', () => {
  const settings = defaultAiSettings();
  settings.provider = 'deepseek';
  settings.providers.deepseek.credentials = [
    { id: 'd-1', apiKey: 'deep-one', status: 'untested' },
    { id: 'd-2', apiKey: 'deep-two', status: 'valid' }
  ];
  settings.providers.deepseek.activeCredentialId = 'd-2';
  settings.providers.gemini.credentials = [{ id: 'g-1', apiKey: 'gemini-one', status: 'valid' }];
  settings.providers.openai.credentials = [{ id: 'o-1', apiKey: 'openai-one', status: 'untested' }];
  const candidates = buildFallbackCandidates(settings, 'deepseek');
  assert.deepEqual(candidates.map(item => `${item.provider}:${item.credentialId}`), ['deepseek:d-2', 'deepseek:d-1', 'gemini:g-1', 'openai:o-1']);
});

test('hasil credential diperbarui dan key valid menjadi aktif', () => {
  const storage = memoryStorage();
  saveProviderSettings(storage, 'gemini', [{ id: 'g-1', apiKey: 'secret-key' }], 'gemini-3.5-flash-lite');
  markCredentialResult(storage, 'gemini', 'g-1', true);
  const restored = loadAiSettings(storage);
  assert.equal(restored.providers.gemini.credentials[0].status, 'valid');
  assert.equal(restored.providers.gemini.activeCredentialId, 'g-1');
});

test('fallback berhenti pada key pertama yang berhasil dan menyamarkan kegagalan total', async () => {
  const candidates = [
    { provider: 'gemini', model: 'm1', credentialId: 'g-1', apiKey: 'bad-secret' },
    { provider: 'gemini', model: 'm1', credentialId: 'g-2', apiKey: 'good-secret' }
  ];
  const attempts = [];
  const result = await generatePromptsWithFallback({}, candidates, async candidate => {
    attempts.push(candidate.credentialId);
    if (candidate.credentialId === 'g-1') throw new Error(`invalid ${candidate.apiKey}`);
    return { prompts: 'ok', provider: candidate.provider, model: candidate.model };
  });
  assert.equal(result.prompts, 'ok');
  assert.deepEqual(attempts, ['g-1', 'g-2']);
  await assert.rejects(
    generatePromptsWithFallback({}, candidates.slice(0, 1), async candidate => { throw new Error(`invalid ${candidate.apiKey}`); }),
    error => error.message === 'Semua API key gagal. Gemini Key 1 gagal.' && !error.message.includes('bad-secret')
  );
});

test('isi localStorage rusak kembali ke pengaturan aman', () => {
  const restored = loadAiSettings(memoryStorage({ [STORAGE_KEY]: '{not-json' }));
  assert.equal(restored.provider, 'gemini');
  assert.equal(restored.providers.gemini.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(restored.providers.gemini.credentials, []);
});
