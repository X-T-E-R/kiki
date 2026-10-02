/**
 * preview-media — video containers and a bare binary feeding the preview
 * workspace. The mp4 plays in the tab's HTML5 player (bytes via fs:content);
 * a truncated copy of the same file exercises the unplayable → download
 * fallback, and a zip lands on the binary view directly. The walker also
 * boots the desktop shell mock to capture the opener pair that only exists
 * beside the download anchor there.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fid,
  sessionRecord,
  ts,
} from './helpers.mjs';

const SID = 'session_fixture_preview_media';

// Reuses the appearance pack's demo clip (h264, 1280×720, 3s).
const DRIFT_B64 = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'appearance-media', 'drift-720.mp4'),
).toString('base64');
// 96 bytes of the same container: the demuxer must give up, not hang.
const BROKEN_B64 = DRIFT_B64.slice(0, 128);
const ZIP_B64 = Buffer.from('PK\x03\x04 fixture archive placeholder', 'latin1').toString('base64');

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: preview media' })],
  fsFiles: {
    'C:/fixture/workshop/clips/drift-720.mp4': { base64: DRIFT_B64, mime: 'video/mp4' },
    'C:/fixture/workshop/clips/broken.mp4': { base64: BROKEN_B64, mime: 'video/mp4' },
    'C:/fixture/workshop/bundles/release.zip': { base64: ZIP_B64, mime: 'application/zip' },
    'C:/fixture/workshop/notes/readme.txt': { content: 'Fixture note: the release clip ships Friday.\n', mime: 'text/plain' },
  },
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        {
          id: fid('msg'),
          session_id: SID,
          role: 'user',
          content: [{ type: 'text', text: '这几段素材和压缩包帮我看一下' }],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Media shelf: 成片在 [drift-720.mp4](./clips/drift-720.mp4)，截坏的拷贝是 [broken.mp4](./clips/broken.mp4)，归档是 [release.zip](./bundles/release.zip)，说明在 [readme.txt](./notes/readme.txt)。',
            },
          ],
          created_at: ts(4),
        },
      ],
    },
  },
};
