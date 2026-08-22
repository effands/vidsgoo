const fs = require('node:fs');
const path = require('node:path');

function parsePromptBlocks(input) {
  if (typeof input !== 'string') return [];
  return input
    .split(/\r?\n[\t ]*\r?\n+/)
    .map(prompt => prompt.trim())
    .filter(Boolean);
}

function resolveSpintax(input, variationIndex = 0) {
  if (typeof input !== 'string') return '';
  let cursor = Number.isInteger(variationIndex) && variationIndex >= 0 ? variationIndex : 0;
  return input.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, body) => {
    const options = body.split('|');
    const selected = options[cursor % options.length];
    cursor = Math.floor(cursor / options.length);
    return selected;
  });
}

function decideVideoAiRetry(error, currentCount = 0, maxRefreshes = 4) {
  if (!/VIDEO_AI_CLICK_FAILED/i.test(String(error || ''))) return null;
  const count = Number.isInteger(currentCount) && currentCount >= 0 ? currentCount : 0;
  if (count < maxRefreshes) {
    return { retryable: true, nextCount: count + 1, error: String(error) };
  }
  return {
    retryable: false,
    nextCount: count,
    error: 'Video AI gagal terbuka setelah 1 klik pada 4 refresh. Silakan klik tombol Video AI secara manual, lalu jalankan ulang task.'
  };
}

function decideStandardPromptCleanupRetry(error, currentCount = 0, maxRefreshes = 2) {
  if (!/STANDARD_PROMPT_(?:CLEANUP|INPUT)_FAILED/i.test(String(error || ''))) return null;
  const count = Number.isInteger(currentCount) && currentCount >= 0 ? currentCount : 0;
  if (count < maxRefreshes) return { retryable: true, nextCount: count + 1, error: String(error) };
  return {
    retryable: false,
    nextCount: count,
    error: 'Prompt lama mode Buat Video tetap tidak dapat dibersihkan setelah 2 refresh. Task gagal dan lanjut ke task berikutnya.'
  };
}

function inspectVideoFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size < 12) return { valid: false, reason: 'File kosong atau terlalu kecil.' };

    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);

    const extension = path.extname(filePath).toLowerCase();
    const isMp4 = extension === '.mp4' && header.subarray(4, 8).toString('ascii') === 'ftyp';
    const isWebm = extension === '.webm' && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return { valid: isMp4 || isWebm, size: stats.size, stats, reason: isMp4 || isWebm ? null : 'Signature video tidak valid.' };
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

function resolveVideoTarget(roots, source, filename) {
  const root = roots[source];
  if (!root) throw new Error('Sumber video tidak valid.');
  if (!filename || typeof filename !== 'string') throw new Error('Nama file tidak valid.');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, filename);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Nama file tidak valid.');
  }
  return target;
}

module.exports = { parsePromptBlocks, resolveSpintax, decideVideoAiRetry, decideStandardPromptCleanupRetry, inspectVideoFile, resolveVideoTarget };
