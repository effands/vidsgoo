const fs = require('node:fs');
const path = require('node:path');

function parsePromptBlocks(input) {
  if (typeof input !== 'string') return [];
  return input
    .split(/\r?\n[\t ]*\r?\n+/)
    .map(prompt => prompt.trim())
    .filter(Boolean);
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
  if (!filename || path.basename(filename) !== filename) throw new Error('Nama file tidak valid.');
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, filename);
  if (path.dirname(target) !== resolvedRoot) throw new Error('Nama file tidak valid.');
  return target;
}

module.exports = { parsePromptBlocks, inspectVideoFile, resolveVideoTarget };
