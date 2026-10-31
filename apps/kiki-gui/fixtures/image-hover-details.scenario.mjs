/**
 * image-hover-details — a session whose transcript carries a ReadMediaFile
 * image with a long Windows host path, backing the lightbox details
 * hover/focus walk: the popup shows the full real path (wrapped, not
 * truncated), revealed on hover and keyboard focus, never pinned by a click.
 * fs:content backs the host bytes; a second user image is a remote URL.
 */

import { deflateSync } from 'node:zlib';

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_image_hover';

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

function picture(width, height, color) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let random = 987654321;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      const noise = random & 31;
      pixels[offset] = Math.min(255, color[0] + Math.floor(50 * x / width) + noise);
      pixels[offset + 1] = Math.min(255, color[1] + Math.floor(50 * y / height) + noise);
      pixels[offset + 2] = Math.min(255, color[2] + noise);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export const IMAGE_PATH = 'C:/Users/someone/AppData/Local/Programs/Kiki/workspaces/deeply/nested/project/output/renders/2026-11-01/session-screenshots/final-composite-frame.png';

const FRAME = picture(640, 400, [40, 110, 90]);
const FRAME_DATA_URL = `data:image/png;base64,${FRAME.toString('base64')}`;

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: image hover details' })],
  fsFiles: {
    [IMAGE_PATH]: { base64: FRAME.toString('base64'), mime: 'image/png' },
  },
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        {
          id: fid('msg'),
          session_id: SID,
          role: 'user',
          content: [{ type: 'text', text: '刚渲染好的合成帧，帮我确认一下效果。' }],
          created_at: ts(6),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            { type: 'text', text: '成片在这里，长路径原图我先读一下。' },
            {
              type: 'tool_use',
              tool_call_id: 'call_frame_1',
              tool_name: 'ReadMediaFile',
              input: { path: IMAGE_PATH },
            },
          ],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: 'call_frame_1',
              output: [
                { type: 'text', text: `<image path="${IMAGE_PATH}">` },
                { type: 'image_url', imageUrl: { url: FRAME_DATA_URL } },
                { type: 'text', text: '</image>' },
              ],
            },
          ],
          created_at: ts(4),
        },
      ],
    },
  },
};
