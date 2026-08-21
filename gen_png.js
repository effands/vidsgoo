const fs = require('fs');

// Simple PNG 128x128 with a nice icon color
// Generates a proper transparent PNG file buffer
function createPng128() {
  const width = 128;
  const height = 128;
  const zlib = require('zlib');

  // Build raw RGBA data
  const rawData = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Draw rounded rectangle icon in Cyan/Blue
      const cx = x - 64;
      const cy = y - 64;
      const dist = Math.sqrt(cx * cx + cy * cy);

      if (dist < 56) {
        // Gradient blue inside
        rawData[idx] = 14;      // R
        rawData[idx + 1] = 165; // G
        rawData[idx + 2] = 233; // B
        rawData[idx + 3] = 255; // A
      } else {
        rawData[idx] = 0;
        rawData[idx + 1] = 0;
        rawData[idx + 2] = 0;
        rawData[idx + 3] = 0; // Transparent
      }
    }
  }

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT Chunk (Scanlines with filter byte 0)
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0; // Filter none
    rawData.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(scanlines);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND Chunk
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon128.png', png);
  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon48.png', png);
  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon16.png', png);
  console.log('PNG Icons generated successfully!');
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(4 + 4 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4);
  data.copy(buf, 8);

  const crc32 = require('zlib').crc32 || simpleCrc32;
  const crcVal = crc32(buf.slice(4, 8 + len));
  buf.writeUInt32BE(crcVal >>> 0, 8 + len);
  return buf;
}

function simpleCrc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    let byte = buf[i];
    for (let j = 0; j < 8; j++) {
      let mix = (crc ^ byte) & 1;
      crc = (crc >>> 1) ^ (mix ? 0xedb88320 : 0);
      byte >>>= 1;
    }
  }
  return (crc ^ -1);
}

createPng128();
