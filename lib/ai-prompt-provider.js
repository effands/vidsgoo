const AI_PROVIDER_MODELS = Object.freeze({
  gemini: Object.freeze([
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash'
  ]),
  deepseek: Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']),
  groq: Object.freeze(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini']),
  openai: Object.freeze(['gpt-5-mini', 'gpt-5', 'gpt-5.4'])
});

const PROVIDER_LABELS = Object.freeze({
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openai: 'OpenAI'
});

function normalizeVideoCount(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return 1;
  return Math.min(20, Math.max(1, parsed));
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!Object.hasOwn(AI_PROVIDER_MODELS, provider)) {
    throw new Error('Provider AI tidak didukung.');
  }
  return provider;
}

function normalizeModel(provider, value) {
  const model = String(value || AI_PROVIDER_MODELS[provider][0]).trim();
  if (!model || !/^[a-zA-Z0-9._/-]{2,120}$/.test(model)) {
    throw new Error('Nama model AI tidak valid.');
  }
  if (provider === 'gemini' && !AI_PROVIDER_MODELS.gemini.includes(model)) {
    throw new Error('Model Gemini harus versi 3.5 atau lebih baru yang didukung.');
  }
  return model;
}

function buildAffiliateInstruction(input) {
  const count = normalizeVideoCount(input.count);
  const detailReference = input.hasDetail ? ' dan @Gambar3 sebagai detail produk' : '';
  return [
    `Tulis tepat ${count} prompt video affiliate UGC dalam bahasa Indonesia.`,
    `Produk: ${String(input.productName || '').trim()}.`,
    `Keunggulan: ${String(input.usp || '').trim()}.`,
    `CTA: ${String(input.cta || '').trim()}.`,
    `Gaya: ${String(input.style || 'UGC dengan hook kuat').trim()}.`,
    `Setiap prompt wajib memakai @Gambar1 sebagai avatar dan @Gambar2 sebagai produk${detailReference}.`,
    'Pisahkan setiap prompt dengan satu baris kosong. Jangan gunakan penomoran, judul, Markdown, atau code fence.',
    'Prompt harus langsung dapat ditempel ke Google Vids dan tidak boleh mengubah tag @Gambar.'
  ].join('\n');
}

function cleanPromptOutput(value) {
  return String(value || '')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function openAiOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = Array.isArray(data?.output) ? data.output.flatMap(item => item?.content || []) : [];
  return parts.map(part => part?.text || '').filter(Boolean).join('\n');
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return {};
  }
}

async function generateAffiliatePrompts(input, fetchImpl = globalThis.fetch) {
  const provider = normalizeProvider(input?.provider);
  const apiKey = String(input?.apiKey || '').trim();
  if (!apiKey) throw new Error(`API key ${PROVIDER_LABELS[provider]} wajib diisi.`);
  if (typeof fetchImpl !== 'function') throw new Error('HTTP client tidak tersedia.');

  const model = normalizeModel(provider, input?.model);
  const instruction = buildAffiliateInstruction(input || {});
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    headers['x-goog-api-key'] = apiKey;
    body = { contents: [{ role: 'user', parts: [{ text: instruction }] }] };
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/responses';
    headers.Authorization = `Bearer ${apiKey}`;
    body = { model, input: instruction, max_output_tokens: 1800 };
  } else {
    url = provider === 'deepseek'
      ? 'https://api.deepseek.com/chat/completions'
      : 'https://api.groq.com/openai/v1/chat/completions';
    headers.Authorization = `Bearer ${apiKey}`;
    body = {
      model,
      messages: [
        { role: 'system', content: 'Anda menulis prompt produksi video UGC yang ringkas dan dapat langsung digunakan.' },
        { role: 'user', content: instruction }
      ]
    };
    if (provider === 'deepseek') body.max_tokens = 1800;
    else body.max_completion_tokens = 1800;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000)
    });
  } catch (_) {
    throw new Error(`${PROVIDER_LABELS[provider]} tidak dapat dihubungi. Periksa koneksi lalu coba lagi.`);
  }

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(`${PROVIDER_LABELS[provider]} menolak permintaan (HTTP ${response.status}). Periksa API key dan model.`);
  }

  const rawText = provider === 'gemini'
    ? data?.candidates?.[0]?.content?.parts?.map(part => part?.text || '').join('\n')
    : provider === 'openai'
      ? openAiOutputText(data)
      : data?.choices?.[0]?.message?.content;
  const prompts = cleanPromptOutput(rawText);
  if (!prompts) throw new Error(`${PROVIDER_LABELS[provider]} tidak mengembalikan prompt.`);

  return { prompts, provider, model };
}

async function testAiConnection(input, fetchImpl = globalThis.fetch) {
  const provider = normalizeProvider(input?.provider);
  const apiKey = String(input?.apiKey || '').trim();
  if (!apiKey) throw new Error(`API key ${PROVIDER_LABELS[provider]} wajib diisi.`);
  if (typeof fetchImpl !== 'function') throw new Error('HTTP client tidak tersedia.');
  const model = normalizeModel(provider, input?.model);
  let url;
  const headers = {};

  if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
    headers['x-goog-api-key'] = apiKey;
  } else {
    const baseUrl = provider === 'openai'
      ? 'https://api.openai.com/v1'
      : provider === 'deepseek'
        ? 'https://api.deepseek.com'
        : 'https://api.groq.com/openai/v1';
    url = provider === 'deepseek' ? `${baseUrl}/models` : `${baseUrl}/models/${encodeURIComponent(model)}`;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(20000)
    });
  } catch (_) {
    throw new Error(`${PROVIDER_LABELS[provider]} tidak dapat dihubungi. Periksa koneksi lalu coba lagi.`);
  }

  const data = await readJson(response);
  if (!response.ok) {
    throw new Error(`${PROVIDER_LABELS[provider]} menolak permintaan (HTTP ${response.status}). Periksa API key dan model.`);
  }
  if (provider === 'deepseek' && Array.isArray(data?.data) && !data.data.some(item => item?.id === model)) {
    throw new Error(`API key DeepSeek valid, tetapi model ${model} tidak tersedia.`);
  }
  return { valid: true, provider, model };
}

module.exports = {
  AI_PROVIDER_MODELS,
  buildAffiliateInstruction,
  generateAffiliatePrompts,
  normalizeVideoCount,
  testAiConnection
};
