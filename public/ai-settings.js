(function attachAiSettings(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VidsGooAiSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAiSettingsApi() {
  const STORAGE_KEY = 'vidsGoo.aiPromptSettings.v2';
  const LEGACY_STORAGE_KEY = 'vidsGoo.aiPromptSettings.v1';
  const PROVIDER_ORDER = Object.freeze(['gemini', 'deepseek', 'groq', 'openai']);
  const PROVIDER_LABELS = Object.freeze({ gemini: 'Gemini', deepseek: 'DeepSeek', groq: 'Groq', openai: 'OpenAI' });
  const DEFAULT_MODELS = Object.freeze({
    gemini: 'gemini-3.5-flash-lite',
    deepseek: 'deepseek-v4-flash',
    groq: 'openai/gpt-oss-20b',
    openai: 'gpt-5-mini'
  });

  function defaultAiSettings() {
    return {
      provider: 'gemini',
      providers: Object.fromEntries(PROVIDER_ORDER.map(provider => [provider, {
        model: DEFAULT_MODELS[provider], credentials: [], activeCredentialId: ''
      }]))
    };
  }

  function normalizeCredentials(provider, credentials) {
    const source = typeof credentials === 'string'
      ? [{ apiKey: credentials }]
      : Array.isArray(credentials) ? credentials : [];
    const seen = new Set();
    return source.flatMap((credential, index) => {
      const apiKey = String(credential?.apiKey || '').trim();
      if (!apiKey || seen.has(apiKey)) return [];
      seen.add(apiKey);
      const status = ['untested', 'valid', 'failed'].includes(credential?.status) ? credential.status : 'untested';
      return [{
        id: String(credential?.id || `${provider}-key-${index + 1}`),
        apiKey,
        status
      }];
    });
  }

  function normalizeSettings(parsed) {
    const settings = defaultAiSettings();
    if (!parsed || typeof parsed !== 'object') return settings;
    settings.provider = Object.hasOwn(DEFAULT_MODELS, parsed.provider) ? parsed.provider : settings.provider;
    for (const provider of PROVIDER_ORDER) {
      const saved = parsed.providers?.[provider];
      if (!saved || typeof saved !== 'object') continue;
      const credentials = normalizeCredentials(provider, Array.isArray(saved.credentials) ? saved.credentials : saved.apiKey || '');
      const activeCredentialId = credentials.some(item => item.id === saved.activeCredentialId)
        ? String(saved.activeCredentialId)
        : '';
      settings.providers[provider] = {
        model: String(saved.model || DEFAULT_MODELS[provider]),
        credentials,
        activeCredentialId
      };
    }
    return settings;
  }

  function loadAiSettings(storage) {
    try {
      const current = storage?.getItem(STORAGE_KEY);
      if (current !== null && current !== undefined) return normalizeSettings(JSON.parse(current));
      const legacy = storage?.getItem(LEGACY_STORAGE_KEY);
      return legacy ? normalizeSettings(JSON.parse(legacy)) : defaultAiSettings();
    } catch (_) {
      return defaultAiSettings();
    }
  }

  function persistSettings(storage, settings) {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
    return settings;
  }

  function saveProviderSettings(storage, provider, credentials, model) {
    if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error('Provider AI tidak didukung.');
    const settings = loadAiSettings(storage);
    const normalized = normalizeCredentials(provider, credentials);
    const previousActive = settings.providers[provider].activeCredentialId;
    settings.provider = provider;
    settings.providers[provider] = {
      model: String(model || DEFAULT_MODELS[provider]).trim(),
      credentials: normalized,
      activeCredentialId: normalized.some(item => item.id === previousActive) ? previousActive : ''
    };
    return persistSettings(storage, settings);
  }

  function markCredentialResult(storage, provider, credentialId, valid) {
    const settings = loadAiSettings(storage);
    const providerSettings = settings.providers[provider];
    if (!providerSettings) return settings;
    const credential = providerSettings.credentials.find(item => item.id === credentialId);
    if (!credential) return settings;
    credential.status = valid ? 'valid' : 'failed';
    if (valid) providerSettings.activeCredentialId = credentialId;
    return persistSettings(storage, settings);
  }

  function buildFallbackCandidates(settingsInput, preferredProvider) {
    const settings = normalizeSettings(settingsInput);
    const firstProvider = Object.hasOwn(DEFAULT_MODELS, preferredProvider) ? preferredProvider : settings.provider;
    const providers = [firstProvider, ...PROVIDER_ORDER.filter(provider => provider !== firstProvider)];
    return providers.flatMap(provider => {
      const providerSettings = settings.providers[provider];
      const credentials = [...providerSettings.credentials].sort((left, right) => {
        if (left.id === providerSettings.activeCredentialId) return -1;
        if (right.id === providerSettings.activeCredentialId) return 1;
        return 0;
      });
      return credentials.map((credential, index) => ({
        provider,
        providerLabel: PROVIDER_LABELS[provider],
        model: providerSettings.model,
        credentialId: credential.id,
        credentialLabel: `Key ${index + 1}`,
        apiKey: credential.apiKey
      }));
    });
  }

  async function generatePromptsWithFallback(basePayload, candidates, requestFn, onAttempt) {
    const failures = [];
    const providerAttemptCounts = {};
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      providerAttemptCounts[candidate.provider] = (providerAttemptCounts[candidate.provider] || 0) + 1;
      try {
        const result = await requestFn(candidate, {
          ...basePayload,
          provider: candidate.provider,
          model: candidate.model,
          apiKey: candidate.apiKey
        });
        if (typeof onAttempt === 'function') onAttempt(candidate, true);
        return result;
      } catch (_) {
        const credentialLabel = candidate.credentialLabel || `Key ${providerAttemptCounts[candidate.provider]}`;
        failures.push(`${candidate.providerLabel || PROVIDER_LABELS[candidate.provider] || candidate.provider} ${credentialLabel} gagal`);
        if (typeof onAttempt === 'function') onAttempt(candidate, false);
      }
    }
    const detail = failures.length ? ` ${failures.join(', ')}.` : ' Tidak ada API key yang tersimpan.';
    throw new Error(`Semua API key gagal.${detail}`);
  }

  return {
    STORAGE_KEY,
    LEGACY_STORAGE_KEY,
    PROVIDER_ORDER,
    PROVIDER_LABELS,
    DEFAULT_MODELS,
    defaultAiSettings,
    loadAiSettings,
    saveProviderSettings,
    markCredentialResult,
    buildFallbackCandidates,
    generatePromptsWithFallback
  };
});
