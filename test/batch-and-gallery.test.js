const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePromptBlocks, resolveSpintax, inspectVideoFile, resolveVideoTarget, decideVideoAiRetry, decideStandardPromptCleanupRetry } = require('../lib/job-utils');

test('spintax memilih kombinasi berbeda per indeks tanpa mengubah tag gambar', () => {
  const template = '@Gambar1 {tersenyum|berbicara} sambil {membawa|menunjukkan} @Gambar2';
  assert.equal(resolveSpintax(template, 0), '@Gambar1 tersenyum sambil membawa @Gambar2');
  assert.equal(resolveSpintax(template, 1), '@Gambar1 berbicara sambil membawa @Gambar2');
  assert.equal(resolveSpintax(template, 2), '@Gambar1 tersenyum sambil menunjukkan @Gambar2');
  assert.equal(resolveSpintax(template, 4), '@Gambar1 tersenyum sambil membawa @Gambar2');
});

test('spintax membiarkan kurung biasa dan grup tanpa pilihan tetap utuh', () => {
  assert.equal(resolveSpintax('UGC {santai} rasio (9:16)', 0), 'UGC {santai} rasio (9:16)');
});

test('Video AI retries at most four refreshes then asks the user to click manually', () => {
  for (let count = 0; count < 4; count++) {
    const decision = decideVideoAiRetry('VIDEO_AI_CLICK_FAILED: panel tidak terbuka', count);
    assert.equal(decision.retryable, true);
    assert.equal(decision.nextCount, count + 1);
  }
  const terminal = decideVideoAiRetry('VIDEO_AI_CLICK_FAILED: panel tidak terbuka', 4);
  assert.equal(terminal.retryable, false);
  assert.match(terminal.error, /klik tombol Video AI secara manual/i);
});

test('Buat Video retries prompt cleanup twice then continues to the next task', () => {
  const error = 'STANDARD_PROMPT_CLEANUP_FAILED: Prompt lama Google Vids tidak berhasil dibersihkan.';
  assert.deepEqual(decideStandardPromptCleanupRetry(error, 0), { retryable: true, nextCount: 1, error });
  assert.deepEqual(decideStandardPromptCleanupRetry(error, 1), { retryable: true, nextCount: 2, error });
  const terminal = decideStandardPromptCleanupRetry(error, 2);
  assert.equal(terminal.retryable, false);
  assert.match(terminal.error, /lanjut ke task berikutnya/i);
  assert.equal(decideStandardPromptCleanupRetry('error affiliate', 0), null);
  assert.equal(decideStandardPromptCleanupRetry('STANDARD_PROMPT_INPUT_FAILED: teks tidak masuk', 0).retryable, true);
});

test('satu prompt mempertahankan seluruh barisnya', () => {
  const input = 'Adegan sungai\nKabut tipis\nKamera bergerak perlahan';
  assert.deepEqual(parsePromptBlocks(input), [input]);
});

test('batch dipisahkan dengan Enter dua kali atau satu baris kosong', () => {
  const input = 'Prompt satu\nmultiline\n\nPrompt dua\nmultiline';
  assert.deepEqual(parsePromptBlocks(input), ['Prompt satu\nmultiline', 'Prompt dua\nmultiline']);
});

test('beberapa baris kosong tidak membuat prompt kosong', () => {
  const input = 'Prompt awal\n\n\n\nPrompt kedua\n\nPrompt ketiga';
  assert.deepEqual(parsePromptBlocks(input), ['Prompt awal', 'Prompt kedua', 'Prompt ketiga']);
});

test('gallery menolak file kosong dan menerima MP4 dengan signature ftyp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vids-gallery-'));
  const empty = path.join(dir, 'empty.mp4');
  const valid = path.join(dir, 'valid.mp4');
  fs.writeFileSync(empty, Buffer.alloc(0));
  fs.writeFileSync(valid, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)]));

  assert.equal(inspectVideoFile(empty).valid, false);
  assert.equal(inspectVideoFile(valid).valid, true);
});

test('target hapus tidak boleh keluar dari folder video yang diizinkan', () => {
  const roots = { server: 'C:\\app\\downloads', chrome: 'C:\\Users\\Demo\\Downloads\\Google_Vids' };
  assert.equal(resolveVideoTarget(roots, 'server', 'hasil.mp4'), path.resolve(roots.server, 'hasil.mp4'));
  assert.throws(() => resolveVideoTarget(roots, 'server', '..\\rahasia.mp4'), /Nama file tidak valid/);
  assert.throws(() => resolveVideoTarget(roots, 'unknown', 'hasil.mp4'), /Sumber video tidak valid/);
});
