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
    assert.equal(data.count, 2);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    const statusData = await statusRes.json();
    
    const affiliateTasks = statusData.queue.filter(t => t.mode === 'affiliate');
    assert.ok(affiliateTasks.length >= 2);
    const task = affiliateTasks[affiliateTasks.length - 2];
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
    assert.equal(affiliateTasks[affiliateTasks.length - 1].batchId, task.batchId);
    assert.equal(affiliateTasks[affiliateTasks.length - 1].batchPrompts, payload.prompts);
    assert.equal(affiliateTasks[affiliateTasks.length - 1].prompt, '@Gambar1 berbicara saat mereview @Gambar2 dengan detail @Gambar3.');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
