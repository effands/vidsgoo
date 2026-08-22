const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_PROVIDER_MODELS,
  generateAffiliatePrompts,
  normalizeVideoCount,
  testAiConnection
} = require('../lib/ai-prompt-provider');

test('Gemini menyediakan model 3.5 ke atas dan memilih Flash-Lite sebagai default', () => {
  assert.deepEqual(AI_PROVIDER_MODELS.gemini, [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash'
  ]);
});

test('jumlah video kosong atau tidak valid kembali ke satu', () => {
  assert.equal(normalizeVideoCount(undefined), 1);
  assert.equal(normalizeVideoCount('0'), 1);
  assert.equal(normalizeVideoCount('3'), 3);
  assert.equal(normalizeVideoCount('99'), 20);
});

test('Gemini menghasilkan prompt tanpa membocorkan API key ke hasil', async () => {
  const secret = 'gemini-secret-key';
  let request;
  const fakeFetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '@Gambar1 memperkenalkan @Gambar2.' }] } }]
      })
    };
  };

  const result = await generateAffiliatePrompts({
    provider: 'gemini',
    apiKey: secret,
    model: 'gemini-3.7-flash',
    productName: 'Parfum pria',
    usp: 'Tahan seharian',
    cta: 'Klik keranjang',
    count: 1
  }, fakeFetch);

  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], secret);
  assert.equal(result.prompts, '@Gambar1 memperkenalkan @Gambar2.');
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('provider OpenAI-compatible memakai endpoint dan membaca isi respons yang benar', async () => {
  const fixtures = [
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'deepseek-v4-flash'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'openai/gpt-oss-20b']
  ];

  for (const [provider, expectedUrl, model] of fixtures) {
    let request;
    const result = await generateAffiliatePrompts({
      provider,
      apiKey: `${provider}-secret`,
      model,
      productName: 'Produk',
      usp: 'Keunggulan',
      cta: 'Beli sekarang',
      count: 2
    }, async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Prompt satu\n\nPrompt dua' } }] })
      };
    });

    assert.equal(request.url, expectedUrl);
    const body = JSON.parse(request.options.body);
    assert.equal(body.model, model);
    if (provider === 'deepseek') {
      assert.equal(body.max_tokens, 1800);
      assert.equal(body.max_completion_tokens, undefined);
    } else {
      assert.equal(body.max_completion_tokens, 1800);
    }
    assert.equal(result.prompts, 'Prompt satu\n\nPrompt dua');
  }
});

test('OpenAI memakai Responses API dan membaca output_text', async () => {
  let request;
  const result = await generateAffiliatePrompts({
    provider: 'openai',
    apiKey: 'openai-secret',
    model: 'gpt-5-mini',
    productName: 'Produk',
    usp: 'Keunggulan',
    cta: 'Beli sekarang',
    count: 1
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ output_text: '@Gambar1 mereview @Gambar2.' }) };
  });

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(JSON.parse(request.options.body).model, 'gpt-5-mini');
  assert.equal(result.prompts, '@Gambar1 mereview @Gambar2.');
});

test('kesalahan provider disederhanakan tanpa menyertakan API key', async () => {
  const secret = 'must-not-leak';
  await assert.rejects(
    generateAffiliatePrompts({
      provider: 'groq', apiKey: secret, model: 'bad-model', productName: 'Produk', count: 1
    }, async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: `Invalid key ${secret}` } })
    })),
    error => error.message === 'Groq menolak permintaan (HTTP 401). Periksa API key dan model.' && !error.message.includes(secret)
  );
});

test('test API key memeriksa model provider tanpa membocorkan key', async () => {
  const secret = 'connection-secret';
  let request;
  const result = await testAiConnection({
    provider: 'gemini', apiKey: secret, model: 'gemini-3.5-flash-lite'
  }, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ name: 'models/gemini-3.5-flash-lite' }) };
  });

  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite');
  assert.equal(request.options.headers['x-goog-api-key'], secret);
  assert.deepEqual(result, { valid: true, provider: 'gemini', model: 'gemini-3.5-flash-lite' });
  assert.ok(!JSON.stringify(result).includes(secret));
});
