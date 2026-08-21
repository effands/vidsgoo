const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parsePromptBlocks, inspectVideoFile, resolveVideoTarget } = require('../lib/job-utils');

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
