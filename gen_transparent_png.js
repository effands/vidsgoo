const fs = require('fs');

// Script to make transparent background PNG icon by stripping white pixels (RGB > 240)
function makeTransparentPng() {
  const zlib = require('zlib');
  const srcPng = fs.readFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon128.png');

  // Generate clean transparent camera icon RGBA
  const width = 128;
  const height = 128;

  const rawData = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const cx = x - 64;
      const cy = y - 64;
      const dist = Math.sqrt(cx * cx + cy * cy);

      // Smooth circular camera icon with cyan gradient & white icon details
      if (dist < 58) {
        // Cyan blue background
        rawData[idx] = 56;      // R
        rawData[idx + 1] = 189; // G
        rawData[idx + 2] = 248; // B
        rawData[idx + 3] = 255; // Alpha fully opaque inside circle

        // Inner white camera shape details
        if ((Math.abs(cx) < 26 && Math.abs(cy) < 16) || (dist > 28 && dist < 34)) {
          rawData[idx] = 255;
          rawData[idx + 1] = 255;
          rawData[idx + 2] = 255;
        }
      } else {
        // Transparent outside the circle!
        rawData[idx] = 0;
        rawData[idx + 1] = 0;
        rawData[idx + 2] = 0;
        rawData[idx + 3] = 0; // Alpha transparent
      }
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const ihdrChunk = makeChunk('IHDR', ihdr);

  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    scanlines[y * (width * 4 + 1)] = 0;
    rawData.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(scanlines);
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  const png = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);

  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon128.png', png);
  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon48.png', png);
  fs.writeFileSync('e:\\AUTO KLIK\\Vids Goo\\extension\\icon16.png', png);
  console.log('Transparent PNG Icons generated successfully!');
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

makeTransparentPng();
