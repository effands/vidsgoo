const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { app } = require('../server');
const { parsePromptBlocks } = require('../lib/job-utils');

test('parsePromptBlocks separates affiliate prompts preserving @Gambar tags and multiple lines', () => {
  const input = `@Gambar1 buatkan video UGC affiliate dengan 2 detik pertama HOOK untuk @Gambar2 produk @Gambar3 promosikan dalam bahasa indonesia, produk tentang Marshall Major V Headphone warna Cream, akhiri CTA untuk klik keranjang sekarang.

@Gambar1 memegang dan mereview untuk @Gambar2 produk @Gambar3 dengan antusias di awal video. Menunjukkan detail fisik dan menjelaskan suara bass jernih dalam bahasa santai kekinian, diakhiri ajakan tegas untuk klik keranjang sekarang.`;

  const blocks = parsePromptBlocks(input);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes('@Gambar1') && blocks[0].includes('@Gambar2') && blocks[0].includes('@Gambar3'));
  assert.ok(blocks[0].includes('Marshall Major V Headphone warna Cream'));
  assert.ok(blocks[1].includes('suara bass jernih'));
});

test('public/index.html includes 3-Slot Affiliate UGC Studio, media inputs, and follows anti-slop rules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.ok(html.includes('id="tab-affiliate"'), 'Harus memiliki tab affiliate');
  assert.ok(html.includes('id="pane-affiliate"'), 'Harus memiliki panel affiliate');
  assert.ok(html.includes('id="slotInput1"'), 'Harus memiliki input slot 1 (Avatar)');
  assert.ok(html.includes('id="slotInput2"'), 'Harus memiliki input slot 2 (Produk Utama)');
  assert.ok(html.includes('id="slotInput3"'), 'Harus memiliki input slot 3 (Detail)');
  assert.ok(html.includes('id="generateAffScriptBtn"'), 'Harus memiliki tombol generate script');
  assert.ok(html.includes('id="affPrompts"'), 'Harus memiliki textarea batch prompt affiliate');
  assert.ok(html.includes('<label for="affVariationCount">Jumlah Video</label>'), 'Jumlah variasi harus menjelaskan total video');
  assert.ok(html.includes('type="number" id="affVariationCount" value="1" min="1" max="20"'), 'Jumlah video harus mendukung input custom 1 sampai 20');
  assert.ok(html.includes('input[type="number"], select, textarea'), 'Input jumlah video harus memakai style form yang sama');
  assert.match(html, /class="affiliate-primary-fields"[\s\S]*?id="affProductName"[\s\S]*?id="affStyle"[\s\S]*?id="affVariationCount"/, 'Baris utama harus berisi produk, gaya, lalu jumlah video');
  assert.match(html, /class="affiliate-secondary-fields"[\s\S]*?id="affProductUsp"[\s\S]*?id="affCta"/, 'Poin keunggulan harus sejajar dengan CTA');
  assert.ok(html.includes('{review jujur|demo produk|cerita pengalaman}'), 'Panduan prompt harus memuat contoh spintax');
  assert.ok(html.includes('class="card-header upload-card-header"'), 'Judul upload dan badge harus memakai header satu baris');
  assert.ok(html.includes('<span>Upload Gambar</span>'), 'Judul upload harus ringkas tanpa teks maksimal 3');
  assert.ok(!html.includes('Upload Gambar (Maksimal 3)'), 'Batas gambar cukup ditampilkan pada badge');
  assert.match(html, /\.slot-dropzone\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9;/, 'Area upload harus memakai rasio 16:9');
  assert.match(html, /\.slot-preview-box\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9;/, 'Preview upload harus mempertahankan rasio 16:9');
  assert.ok(html.includes('@Gambar1'), 'Harus memiliki referensi tag Gambar1');
  assert.ok(html.includes('@Gambar2'), 'Harus memiliki referensi tag Gambar2');
  assert.ok(html.includes('@Gambar3'), 'Harus memiliki referensi tag Gambar3');
  assert.ok(html.includes('const batchPrompts = task.batchPrompts'), 'Reuse harus memulihkan seluruh batch prompt');
  assert.ok(html.includes('Array.isArray(task.images)'), 'Reuse harus memulihkan gambar referensi');
  assert.ok(html.includes('slotData[slotIndex]'), 'Reuse harus mengembalikan gambar ke slot asalnya');
  assert.ok(html.includes('data-task-action="delete"'), 'Antrean harus memiliki tombol hapus satuan');
  assert.ok(html.includes('window.deleteQueueTask'), 'Tombol hapus satuan harus memiliki handler');
  assert.ok(html.includes('affiliateConfig'), 'Reuse harus menyimpan parameter Smart Affiliate Copywriter');

  // Anti-slop rule: No em dashes
  assert.ok(!html.includes('—'), 'HTML tidak boleh mengandung em dash (anti-slop)');
});

test('server /api/queue/add supports affiliate mode with up to 3 image attachments', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const payload = {
      mode: 'affiliate',
      ratio: '9:16',
      folder: 'Affiliate_Marshall_Cream',
      affiliateConfig: {
        productName: 'Marshall Major V Cream',
        productUsp: 'Baterai 100 jam',
        cta: 'klik keranjang sekarang',
        style: 'honest_review',
        variationCount: '5'
      },
      prompts: '@Gambar1 {tersenyum|berbicara} saat mereview @Gambar2 dengan detail @Gambar3.\n\n@Gambar1 {tersenyum|berbicara} saat mereview @Gambar2 dengan detail @Gambar3.',
      images: [
        { type: 'avatar', tag: '@Gambar1', name: 'avatar_person.jpg', dataUrl: 'data:image/jpeg;base64,123' },
        { type: 'product', tag: '@Gambar2', name: 'marshall_front.jpg', dataUrl: 'data:image/jpeg;base64,456' },
        { type: 'product_detail', tag: '@Gambar3', name: 'marshall_side.jpg', dataUrl: 'data:image/jpeg;base64,789' },
        { type: 'ignored', tag: '@Gambar4', name: 'ignored.jpg', dataUrl: 'data:image/jpeg;base64,000' }
      ]
    };

    const res = await fetch(`http://127.0.0.1:${port}/api/queue/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`,
        'X-Dashboard-Request': 'Google-Vids-Dashboard'
      },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.equal(data.count, 5);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    const statusData = await statusRes.json();
    
    const affiliateTasks = statusData.queue.filter(t => t.mode === 'affiliate');
    assert.ok(affiliateTasks.length >= 5);
    const batchTasks = affiliateTasks.slice(-5);
    const task = batchTasks[0];
    assert.equal(task.mode, 'affiliate');
    assert.equal(task.ratio, '9:16');
    assert.equal(task.folder, 'Affiliate_Marshall_Cream');
    assert.equal(task.images.length, 3);
    assert.equal(task.images[0].tag, '@Gambar1');
    assert.equal(task.images[1].tag, '@Gambar2');
    assert.equal(task.images[2].tag, '@Gambar3');
    assert.deepEqual(task.affiliateConfig, payload.affiliateConfig);
    assert.ok(task.batchId);
    assert.equal(task.batchPrompts, payload.prompts);
    assert.equal(task.promptTemplate, '@Gambar1 {tersenyum|berbicara} saat mereview @Gambar2 dengan detail @Gambar3.');
    assert.equal(task.prompt, '@Gambar1 tersenyum saat mereview @Gambar2 dengan detail @Gambar3.');
    assert.ok(batchTasks.every(item => item.batchId === task.batchId));
    assert.ok(batchTasks.every(item => item.batchPrompts === payload.prompts));
    assert.deepEqual(batchTasks.map(item => item.prompt), [
      '@Gambar1 tersenyum saat mereview @Gambar2 dengan detail @Gambar3.',
      '@Gambar1 berbicara saat mereview @Gambar2 dengan detail @Gambar3.',
      '@Gambar1 tersenyum saat mereview @Gambar2 dengan detail @Gambar3.',
      '@Gambar1 berbicara saat mereview @Gambar2 dengan detail @Gambar3.',
      '@Gambar1 tersenyum saat mereview @Gambar2 dengan detail @Gambar3.'
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Jumlah Video membagi tiga prompt biasa dan mengembangkan satu prompt spintax', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = {
    'Content-Type': 'application/json',
    'Origin': endpoint,
    'X-Dashboard-Request': 'Google-Vids-Dashboard'
  };

  async function addAffiliateBatch(prompts) {
    const response = await fetch(`${endpoint}/api/queue/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'affiliate',
        ratio: '9:16',
        prompts,
        affiliateConfig: { variationCount: '3' }
      })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.count, 3);

    const status = await fetch(`${endpoint}/api/status`).then(res => res.json());
    return status.queue.slice(-3);
  }

  try {
    const plainTasks = await addAffiliateBatch([
      '@Gambar1 memperkenalkan @Gambar2.',
      '@Gambar1 mendemonstrasikan @Gambar2.',
      '@Gambar1 merekomendasikan @Gambar2.'
    ].join('\n\n'));
    assert.deepEqual(plainTasks.map(task => task.prompt), [
      '@Gambar1 memperkenalkan @Gambar2.',
      '@Gambar1 mendemonstrasikan @Gambar2.',
      '@Gambar1 merekomendasikan @Gambar2.'
    ]);

    const spintaxTasks = await addAffiliateBatch(
      '@Gambar1 {memperkenalkan|mendemonstrasikan|merekomendasikan} @Gambar2.'
    );
    assert.deepEqual(spintaxTasks.map(task => task.prompt), [
      '@Gambar1 memperkenalkan @Gambar2.',
      '@Gambar1 mendemonstrasikan @Gambar2.',
      '@Gambar1 merekomendasikan @Gambar2.'
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Affiliate tanpa Jumlah Video eksplisit membuat tepat satu task', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/queue/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({
        mode: 'affiliate',
        prompts: '@Gambar1 mereview @Gambar2.',
        affiliateConfig: {}
      })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).count, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('endpoint generator AI menolak API key kosong tanpa menghubungi provider', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/generate-affiliate-prompts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: '' })
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.match(result.error, /API key Gemini wajib diisi/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('endpoint test API key menolak key kosong sebelum menghubungi provider', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/test-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://127.0.0.1:${port}`
      },
      body: JSON.stringify({ provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: '' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /API key Gemini wajib diisi/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
