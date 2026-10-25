import { deflateSync } from 'node:zlib';
import { sessionRecord, ts } from './helpers.mjs';

export const SID = 'session_fixture_sent_images';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const name = Buffer.from(type);
  const output = Buffer.alloc(bytes.length + 12);
  output.writeUInt32BE(bytes.length);
  name.copy(output, 4);
  bytes.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, bytes])), bytes.length + 8);
  return output;
}

export function picture(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let random = 123456789;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      const noise = random & 31;
      pixels[offset] = Math.min(255, color[0] + Math.floor(60 * x / width) + noise);
      pixels[offset + 1] = Math.min(255, color[1] + Math.floor(60 * y / height) + noise);
      pixels[offset + 2] = Math.min(255, color[2] + noise);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export const pictures = [
  { name: 'small.png', width: 16, height: 16, bytes: picture(16, 16, [20, 90, 150]) },
  { name: 'ordinary.png', width: 480, height: 320, bytes: picture(480, 320, [140, 50, 20]) },
  { name: 'large.png', width: 2400, height: 1400, bytes: picture(2400, 1400, [30, 110, 60]) },
];

export default {
  sessions: [sessionRecord(SID, { title: '已发送图片验证' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [{ id: 'sent-image-message', session_id: SID, role: 'user', created_at: ts(1), content: [
        { type: 'text', text: '三张已发送图片：小图、普通截图、大图。' },
        ...pictures.map(({ bytes }) => ({ type: 'image', source: { kind: 'url', url: `data:image/png;base64,${bytes.toString('base64')}` } })),
      ] }],
    },
  },
};
