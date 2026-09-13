/**
 * preview-workbench — transcript file links feeding the resident preview
 * workspace: a TypeScript module (code tab), a markdown doc (rendered/source
 * toggle), and an SVG (image tab). The fs:content fixture files back the tab
 * fetches; the browser build is read-only, which the walker asserts via the
 * read-only hint strip.
 */

import {
  fid,
  sessionRecord,
  ts,
} from './helpers.mjs';

const SID = 'session_fixture_preview';

const BOARD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <rect width="360" height="220" rx="12" fill="#f3ede1"/>
  <rect x="16" y="16" width="328" height="36" rx="8" fill="#1c1917"/>
  <text x="32" y="39" font-family="monospace" font-size="14" fill="#f3e9d8">kiki board — fixture</text>
  <rect x="16" y="64" width="156" height="140" rx="8" fill="#d8cdb4"/>
  <rect x="188" y="64" width="156" height="64" rx="8" fill="#b3541e"/>
  <rect x="188" y="140" width="156" height="64" rx="8" fill="#8a9a5b"/>
</svg>`;
const BOARD_B64 = Buffer.from(BOARD_SVG, 'utf8').toString('base64');

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

const TASK_SERVICE_TS = Array.from({ length: 1200 }, (_, index) =>
  index === 1062
    ? "export const selectedTask = 'citation-line-1063';"
    : `export const task${index + 1} = ${index + 1};`,
).join('\n');

const DESIGN_MD = `# Board layout

- Header bar in ink
- Two-column body on paper
- Accent card for the active tool

> Spacing follows the 4px grid.
`;

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: preview workbench' })],
  fsFiles: {
    'C:/fixture/workshop/src/server.ts': { content: SERVER_TS, mime: 'text/plain' },
    'C:/fixture/workshop/src/taskService.ts': { content: TASK_SERVICE_TS, mime: 'text/plain' },
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
          content: [{ type: 'text', text: '帮我检查这几个文件的实现和设计是否一致' }],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Workbench notes: 入口在 [server.ts](./src/server.ts)，设计稿在 [design.md](./docs/design.md)，界面截图是 [board.svg](./shots/board.svg)。任务逻辑见 [taskService.ts:1063](/C:/fixture/workshop/src/taskService.ts:1063:14)，也可返回 [taskService.ts:4](C:/fixture/workshop/src/taskService.ts#L4)。',
            },
          ],
          created_at: ts(4),
        },
      ],
    },
  },
};
