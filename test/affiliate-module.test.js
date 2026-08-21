const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { app } = require('../server');
const { parsePromptBlocks } = require('../lib/job-utils');

test('parsePromptBlocks separates affiliate prompts preserving @Gambar tags and multiple lines', () => {
  const input = `@Gambar1 memegang produk @Gambar2 sambil tersenyum.
Menjelaskan keunggulan bass mantap dan noise cancelling.

@Gambar1 unboxing @Gambar2 dan @Gambar3 dengan antusias.
Mengajak penonton langsung checkout di keranjang kuning.`;

  const blocks = parsePromptBlocks(input);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].includes('@Gambar1') && blocks[0].includes('@Gambar2'));
  assert.ok(blocks[1].includes('@Gambar3'));
  assert.ok(blocks[0].includes('Menjelaskan keunggulan bass mantap'));
});

test('public/index.html includes Affiliate UGC Studio tab, media slots, and follows anti-slop rules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  assert.ok(html.includes('id="tab-affiliate"'), 'Harus memiliki tab affiliate');
  assert.ok(html.includes('id="pane-affiliate"'), 'Harus memiliki panel affiliate');
  assert.ok(html.includes('id="affAvatarInput"'), 'Harus memiliki input avatar');
  assert.ok(html.includes('id="affProductInput"'), 'Harus memiliki input produk');
  assert.ok(html.includes('id="generateAffScriptBtn"'), 'Harus memiliki tombol generate script');
  assert.ok(html.includes('id="affPrompts"'), 'Harus memiliki textarea batch prompt affiliate');
  assert.ok(html.includes('@Gambar1'), 'Harus memiliki referensi tag Gambar1');
  assert.ok(html.includes('@Gambar2'), 'Harus memiliki referensi tag Gambar2');

  // Anti-slop rule: No em dashes
  assert.ok(!html.includes('—'), 'HTML tidak boleh mengandung em dash (anti-slop)');
});

test('server /api/queue/add supports affiliate mode with image attachments and metadata', async () => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const payload = {
      mode: 'affiliate',
      ratio: '9:16',
      folder: 'Affiliate_TWS_Pro',
      prompts: '@Gambar1 mereview @Gambar2 dengan antusias.\n\n@Gambar1 unboxing @Gambar2 dengan detail.',
      images: [
        { type: 'avatar', tag: '@Gambar1', name: 'avatar.jpg', dataUrl: 'data:image/jpeg;base64,123' },
        { type: 'product', tag: '@Gambar2', name: 'tws.jpg', dataUrl: 'data:image/jpeg;base64,456' }
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
    assert.equal(task.folder, 'Affiliate_TWS_Pro');
    assert.equal(task.images.length, 2);
    assert.equal(task.images[0].tag, '@Gambar1');
    assert.equal(task.images[1].tag, '@Gambar2');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
