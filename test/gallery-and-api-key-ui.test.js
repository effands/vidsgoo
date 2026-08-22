const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { app } = require('../server');

function contrastRatio(rgbText, backgroundHex) {
  const channels = rgbText.match(/\d+/g).slice(0, 3).map(Number);
  const background = backgroundHex.match(/[a-f\d]{2}/gi).map(value => Number.parseInt(value, 16));
  const luminance = values => {
    const [r, g, b] = values.map(value => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const foregroundLuminance = luminance(channels);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

test('API Key menjadi tab setelah Galeri dan galeri mendukung preview contain serta pilihan hapus', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const deletedUrls = [];

  try {
    await page.route('**/api/gallery', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{
        filename: 'portrait.mp4',
        relativePath: 'Folder_dengan_nama_sangat_panjang_untuk_dipotong/portrait.mp4',
        category: 'Folder_dengan_nama_sangat_panjang_untuk_dipotong',
        url: '/missing-portrait.mp4',
        sizeMB: '2.50',
        source: 'chrome',
        sourceLabel: 'Chrome'
      }])
    }));
    await page.route('**/api/gallery/chrome/**', route => {
      deletedUrls.push(route.request().url());
      return route.fulfill({ contentType: 'application/json', body: '{"success":true}' });
    });
    await page.goto(`http://127.0.0.1:${port}/#gallery`);
    await page.click('#tab-gallery');
    await page.waitForSelector('.gallery-card');

    const navOrder = await page.locator('.nav-tab-btn').evaluateAll(nodes => nodes.map(node => node.id));
    assert.equal(navOrder.indexOf('tab-api-keys'), navOrder.indexOf('tab-gallery') + 1);
    assert.equal(await page.locator('#pane-api-keys #aiProviderTabs').count(), 1);
    assert.equal(await page.locator('#aiProviderTabs [data-provider]').count(), 4);
    assert.equal(await page.locator('#aiCredentialList').count(), 1);
    assert.equal(await page.locator('#addAiCredential').count(), 1);
    assert.equal(await page.locator('#aiFallbackOrder').count(), 1);
    assert.equal(await page.locator('#affAiSettings').count(), 0);
    const videoCountInput = page.locator('#affVariationCount');
    assert.equal(await videoCountInput.evaluate(element => element.tagName), 'INPUT');
    assert.equal(await videoCountInput.getAttribute('type'), 'number');
    assert.equal(await videoCountInput.getAttribute('min'), '1');
    assert.equal(await videoCountInput.getAttribute('max'), '20');
    await videoCountInput.evaluate(element => { element.value = '7'; });
    assert.equal(await videoCountInput.inputValue(), '7');
    assert.equal(await page.locator('#affAiModel').evaluate(element => element.tagName), 'SELECT');
    assert.ok(await page.locator('#affAiModel option').count() >= 4);
    await page.click('#tab-api-keys');
    await page.click('#addAiCredential');
    assert.equal(await page.locator('.ai-credential-card').count(), 1);
    assert.equal(await page.locator('.ai-credential-key').getAttribute('type'), 'password');
    assert.equal(await page.locator('.ai-credential-test').count(), 1);
    await page.click('#tab-gallery');

    const videoStyle = await page.locator('.gallery-card video').evaluate(video => {
      const style = getComputedStyle(video);
      return { aspectRatio: style.aspectRatio, objectFit: style.objectFit };
    });
    assert.equal(videoStyle.aspectRatio, '16 / 9');
    assert.equal(videoStyle.objectFit, 'contain');

    const folderStyle = await page.locator('.gallery-folder-name').evaluate(folder => {
      const style = getComputedStyle(folder);
      return {
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace
      };
    });
    assert.deepEqual(folderStyle, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    assert.equal(await page.locator('.gallery-select-checkbox').count(), 1);
    assert.equal(await page.locator('#deleteSelectedGalleryBtn').count(), 1);

    await page.check('.gallery-select-checkbox');
    await page.click('#deleteSelectedGalleryBtn');
    await page.click('#confirmAccept');
    await page.waitForFunction(() => document.querySelector('#deleteSelectedGalleryBtn')?.textContent?.includes('(0)'));
    assert.equal(deletedUrls.length, 1);
    assert.match(deletedUrls[0], /portrait\.mp4/);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Live Logs menyalin seluruh log mentah dan memberi konfirmasi', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.addInitScript(() => {
      globalThis.__copiedLog = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { globalThis.__copiedLog = text; } }
      });
    });
    await page.route('**/api/status', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ queue: [], isProcessing: false, logs: ['[10:00:00] ASSIGNED | Prompt satu', '[10:00:01] FAILED | Prompt dua'] })
    }));
    await page.goto(`http://127.0.0.1:${port}/#logs`);
    await page.click('#tab-logs');
    await page.waitForSelector('.log-row');
    await page.click('#copyLogsBtn');

    assert.equal(await page.evaluate(() => globalThis.__copiedLog), '[10:00:00] ASSIGNED | Prompt satu\n[10:00:01] FAILED | Prompt dua');
    assert.match(await page.locator('#copyLogsBtn').textContent(), /Tersalin/);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('generator mencoba API key berikutnya setelah key pertama gagal', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const attempts = [];

  try {
    await page.route('**/api/ai/generate-affiliate-prompts', async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      attempts.push(body);
      if (body.apiKey === 'bad-key') {
        return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Key gagal"}' });
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ prompts: '@Gambar1 berhasil memakai @Gambar2.', provider: body.provider, model: body.model })
      });
    });
    await page.goto(`http://127.0.0.1:${port}/#api-keys`);
    await page.click('#tab-api-keys');
    await page.click('#addAiCredential');
    await page.locator('.ai-credential-key').nth(0).fill('bad-key');
    await page.locator('.ai-credential-key').nth(0).press('Tab');
    await page.click('#addAiCredential');
    await page.locator('.ai-credential-key').nth(1).fill('good-key');
    await page.locator('.ai-credential-key').nth(1).press('Tab');
    await page.click('#tab-affiliate');
    await page.fill('#affProductName', 'Produk test');
    await page.click('#generateAffScriptBtn');
    await page.waitForFunction(() => document.querySelector('#affPrompts')?.value.includes('berhasil memakai'));

    assert.deepEqual(attempts.map(item => item.apiKey), ['bad-key', 'good-key']);
    assert.ok(attempts.every(item => typeof item.apiKey === 'string' && !Array.isArray(item.apiKey)));
    assert.match(await page.locator('#affAiGeneratorStatus').textContent(), /prompt siap menggunakan Gemini/);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('header dan navigasi memakai nebula terang tanpa menyebabkan overflow', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForTimeout(250);
    const styles = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector('.top-bar')).backgroundImage,
      menu: getComputedStyle(document.querySelector('.menu-bar')).backgroundImage,
      active: getComputedStyle(document.querySelector('.nav-tab-btn.active')).backgroundImage,
      activeText: getComputedStyle(document.querySelector('.nav-tab-btn.active')).color,
      menuText: getComputedStyle(document.querySelector('.nav-tab-btn:not(.active)')).color,
      page: getComputedStyle(document.body).backgroundImage,
      card: getComputedStyle(document.querySelector('.studio-card')).backgroundImage,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }));
    assert.match(styles.header, /radial-gradient/);
    assert.match(styles.header, /linear-gradient/);
    assert.match(styles.menu, /linear-gradient/);
    assert.match(styles.page, /radial-gradient/);
    assert.match(styles.page, /rgba\(14, 165, 233, 0\.1\)/);
    assert.equal(styles.card, 'none');
    assert.notEqual(styles.active, 'none');
    assert.ok(contrastRatio(styles.activeText, '#bae6fd') >= 4.5);
    assert.ok(contrastRatio(styles.activeText, '#ddd6fe') >= 4.5);
    assert.ok(contrastRatio(styles.menuText, '#e0f2fe') >= 4.5);
    assert.ok(contrastRatio(styles.menuText, '#f3e8ff') >= 4.5);
    assert.equal(styles.overflow, false);

    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.waitForTimeout(250);
    const darkText = await page.evaluate(() => ({
      active: getComputedStyle(document.querySelector('.nav-tab-btn.active')).color,
      menu: getComputedStyle(document.querySelector('.nav-tab-btn:not(.active)')).color,
      page: getComputedStyle(document.body).backgroundImage
    }));
    assert.match(darkText.page, /radial-gradient/);
    assert.match(darkText.page, /rgba\(14, 165, 233, 0\.3\)/);
    assert.notEqual(darkText.page, styles.page);
    assert.ok(contrastRatio(darkText.active, '#171a33') >= 4.5);
    assert.ok(contrastRatio(darkText.menu, '#171a33') >= 4.5);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
