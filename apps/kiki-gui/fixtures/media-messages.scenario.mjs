/**
 * media-messages — a session whose transcript exercises the message media
 * layer end to end:
 *   - user message carrying an inline image (data: URL, as the snapshot
 *     projection delivers composer attachments)
 *   - assistant prose with local-file markdown links (relative + Windows
 *     absolute) that open the file preview pane
 *   - a ReadMediaFile tool result with the raw engine media part array
 *   - an assistant message with a daemon file part (chip, no inline bytes)
 * The fs:content fixture files back the preview pane fetches.
 */

import {
  fid,
  sessionRecord,
  ts,
} from './helpers.mjs';

const SID = 'session_fixture_media';

const BOARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <rect width="360" height="220" rx="12" fill="#f3ede1"/>
  <rect x="16" y="16" width="328" height="36" rx="8" fill="#1c1917"/>
  <text x="32" y="39" font-family="monospace" font-size="14" fill="#f3e9d8">kiki board — fixture</text>
  <rect x="16" y="64" width="156" height="140" rx="8" fill="#d8cdb4"/>
  <rect x="188" y="64" width="156" height="64" rx="8" fill="#b3541e"/>
  <rect x="188" y="140" width="156" height="64" rx="8" fill="#8a9a5b"/>
  <text x="32" y="140" font-family="monospace" font-size="13" fill="#1c1917">render me</text>
</svg>`;
const BOARD_B64 = Buffer.from(BOARD_SVG, 'utf8').toString('base64');
const BOARD_DATA_URL = `data:image/svg+xml;base64,${BOARD_B64}`;

const SERVER_TS = `import { createServer } from 'node:http';

export function boot(port: number) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  server.listen(port);
  return server;
}
`;

const APP_TOML = `[server]
port = 5801
host = "127.0.0.1"

[features]
media_preview = true
`;

const DESIGN_MD = `# Board layout

- Header bar in ink
- Two-column body on paper
- Accent card for the active tool

> Spacing follows the 4px grid.
`;

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: media messages' })],
  fsFiles: {
    'C:/fixture/workshop/config/app.toml': { content: APP_TOML, mime: 'text/plain' },
    'C:/fixture/workshop/src/server.ts': { content: SERVER_TS, mime: 'text/plain' },
    'C:/fixture/workshop/docs/design.md': { content: DESIGN_MD, mime: 'text/plain' },
    'C:/fixture/workshop/shots/board.svg': { base64: BOARD_B64, mime: 'image/svg+xml' },
  },
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        {
          id: fid('msg'),
          session_id: SID,
          role: 'user',
          content: [
            { type: 'text', text: '这是我刚截的界面图，帮我看看布局问题' },
            { type: 'image', source: { kind: 'url', url: BOARD_DATA_URL } },
          ],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '布局问题主要在两处：入口在 [server.ts](./src/server.ts)，服务配置在 [app.toml](C:/fixture/workshop/config/app.toml)，设计稿对照 [design.md](./docs/design.md)。我先读一下截图。',
            },
            {
              type: 'tool_use',
              tool_call_id: 'call_media_1',
              tool_name: 'ReadMediaFile',
              input: { path: 'C:/fixture/workshop/shots/board.svg' },
            },
          ],
          created_at: ts(4),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: 'call_media_1',
              output: [
                { type: 'text', text: '<image path="C:/fixture/workshop/shots/board.svg">' },
                { type: 'image_url', imageUrl: { url: BOARD_DATA_URL } },
                { type: 'text', text: '</image>' },
              ],
            },
          ],
          created_at: ts(4),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            { type: 'text', text: '截图确认是间距问题，原图在 [board.svg](./shots/board.svg)。完整报告我放在这里：' },
            {
              type: 'file',
              file_id: 'file_fixture_report',
              name: 'layout-report.pdf',
              media_type: 'application/pdf',
              size: 48_234,
            },
          ],
          created_at: ts(3),
        },
      ],
    },
  },
};
