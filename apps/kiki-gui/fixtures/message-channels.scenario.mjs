/**
 * message-channels — one persona conversation in `delivery: message` whose
 * turns carry every delivery shape a `SendMessage` receipt can report:
 *
 *   1. a legacy receipt with no `channels` and a bounded long body, so the
 *      pre-channel reading still speaks in full;
 *   2. this conversation delivered a picture, a voice note and a document,
 *      while the same send says a video kind was not taken;
 *   3. delivered to an IM channel only — speech that did not land here;
 *   4. delivered here without the voice note, and not at all on another
 *      channel;
 *   5. no channel confirmed anything: an unknown outcome;
 *   6. every channel failed;
 *   7. the whole send refused because no enabled channel takes the media.
 *
 * The media are real PNG, WAV and Markdown bytes served through the fixture's
 * session-media route, so a thumbnail that renders, a player that plays and a
 * download that arrives are observations rather than mocked successes. All
 * text is synthetic.
 *
 *   node scripts/visual-proof-message-channels.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_message_channels';
const WS = 'wd_fixture_000000000000';
const PERSONA = { id: 'lin-lan', name: '林岚' };

const FIXTURES = dirname(fileURLToPath(import.meta.url));
const COVER = readFileSync(join(FIXTURES, 'media-bytes', 'cover.png'));
const VOICE = readFileSync(join(FIXTURES, 'media-bytes', 'voice.wav'));
const CLIP = readFileSync(join(FIXTURES, 'appearance-media', 'drift-720.mp4'));
const NOTES = Buffer.from(
  '# 0.31 发布清单\n\n- 周四冻结\n- 周五上午打 tag\n- 回滚步骤附在公告草稿后面\n',
  'utf8',
);
const HTML_ENTRY = Buffer.from(
  '<!doctype html><html lang="zh"><head><meta charset="utf-8"/><title>0.31 互动看板</title><link rel="stylesheet" href="./style.css"/></head><body><div class="card"><div class="eyebrow">RELEASE 0.31</div><h1 id="board-title">正在初始化…</h1><p id="board-status">等待脚本与相对资源加载</p></div><script src="./app.js"></script></body></html>',
  'utf8',
);
const HTML_CSS = Buffer.from(
  'body{margin:0;padding:20px;font-family:system-ui,-apple-system,sans-serif;background:#faf8f5;color:#1e1d1a}.card{border:1px solid #e2ddd5;border-radius:12px;padding:18px;background:#fff}.eyebrow{font-family:monospace;font-size:11px;color:#b85a32;letter-spacing:.08em}h1{font-size:18px;margin:6px 0 8px}p{font-size:13px;color:#5c5852;margin:0}',
  'utf8',
);
const HTML_JS = Buffer.from(
  'document.getElementById("board-title").textContent="0.31 路演看板已就绪";document.getElementById("board-status").textContent="相对资源 ./style.css 与 ./app.js 已在独立沙箱加载";window.__boardReady=true;',
  'utf8',
);
const PDF_DOC = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');
const ZIP_ARCHIVE = Buffer.from([80, 75, 3, 4, 20, 0, 0, 0, 0, 0]);

/** The canonical session-media id a receipt carries for these bytes. */
function blobRef(bytes) {
  return `blobref:main:${createHash('sha256').update(bytes).digest('hex')}`;
}

export const MEDIA = {
  image: { id: blobRef(COVER), title: 'cover.png', mime: 'image/png', bytes: COVER },
  voice: { id: blobRef(VOICE), title: '口述备忘.wav', mime: 'audio/wav', bytes: VOICE },
  video: {
    id: blobRef(CLIP), title: 'take-720.mp4', mime: 'video/mp4', bytes: CLIP,
    // A video's preview is a poster frame in the real server; the fixture
    // carries one so the timeline shows a real picture for the clip.
    preview: COVER.toString('base64'), previewMime: 'image/png',
  },
  notes: { id: blobRef(NOTES), title: '0.31-发布清单.md', mime: 'text/markdown', bytes: NOTES },
  html: { id: blobRef(HTML_ENTRY), title: 'index.html', mime: 'text/html', bytes: HTML_ENTRY, path: 'C:/fixture/bots/lin-lan/roadshow/index.html' },
  pdf: { id: blobRef(PDF_DOC), title: '0.31-架构评审.pdf', mime: 'application/pdf', bytes: PDF_DOC },
  zip: { id: blobRef(ZIP_ARCHIVE), title: '0.31-产物归档.zip', mime: 'application/zip', bytes: ZIP_ARCHIVE },
};

function attachment(media, kind) {
  return {
    blob_id: media.id,
    path: media.path ?? `C:/fixture/bots/lin-lan/${media.title}`,
    title: media.title,
    mime_type: media.mime,
    size: media.bytes.byteLength,
    kind,
  };
}

/** A unique tail marker: the body is whole only when it is on the page. */
export const TAIL = 'END-OF-LEGACY-MESSAGE-7d21';

function longBody(chars, tail) {
  const line = '发布清单逐条核对：签名证书、changelog、回归结果、公告草稿与回滚步骤。\n';
  let text = '';
  let index = 0;
  while (text.length + line.length < chars - tail.length) {
    index += 1;
    text += `${String(index).padStart(3, '0')} ${line}`;
  }
  return text.padEnd(chars - tail.length, '·') + tail;
}

export const LEGACY_BODY = longBody(9_000, TAIL);

const LOCAL_DELIVERED = '三样都收到了：封面图、语音备忘，还有清单文件、HTML 互动看板、PDF 评审与在线状态页 https://status.example.com/release-031 。语音是这里收到的语音条，不是转成音频的附件。';
const ELSEWHERE = '这条只发到 Telegram 群里了，对话框里不该把它当成已经收到。';
const PARTIAL = '图发到了，语音这条没送出去，另一个频道连图都没收到。';
const UNCONFIRMED = '这条可能发出去了，也可能没有；没有信道确认。';
const ALL_FAILED = '这条哪个信道都没送到。';
const REFUSED_MEDIA = 'media_unsupported: No enabled channel supports video (video/mp4).';

function sender() {
  return { persona_id: PERSONA.id, name: PERSONA.name, session_id: SID };
}

function receipt(value) {
  return JSON.stringify({ ...value, sender: sender() }, null, 2);
}

const RECEIPTS = {
  legacy: receipt({ message_id: 'send:t1', delivered_to: ['user'], attachments: [] }),
  delivered: receipt({
    message_id: 'send:t2',
    delivered_to: ['user'],
    delivery: 'delivered',
    channels: [
      { channel_id: 'internal', status: 'delivered' },
      { channel_id: 'im:tg-main', status: 'delivered', message_ids: ['4210'] },
    ],
    attachments: [
      attachment(MEDIA.image, 'image'), attachment(MEDIA.voice, 'voice'),
      attachment(MEDIA.video, 'video'), attachment(MEDIA.notes, 'file'),
      attachment(MEDIA.html, 'file'), attachment(MEDIA.pdf, 'file'),
      attachment(MEDIA.zip, 'file'),
    ],
  }),
  elsewhere: receipt({
    message_id: 'send:t3',
    delivered_to: ['user'],
    delivery: 'delivered',
    channels: [{ channel_id: 'im:tg-main', status: 'delivered', message_ids: ['4211'] }],
    attachments: [attachment(MEDIA.image, 'image')],
  }),
  partial: receipt({
    message_id: 'send:t4',
    delivered_to: ['user'],
    delivery: 'delivered',
    channels: [
      { channel_id: 'internal', status: 'delivered', unsupported: ['voice'] },
      { channel_id: 'im:tg-main', status: 'delivered', message_ids: ['4212'], unsupported: ['voice'] },
      { channel_id: 'im:slack-ops', status: 'unsupported', unsupported: ['image', 'voice'] },
    ],
    attachments: [attachment(MEDIA.image, 'image'), attachment(MEDIA.voice, 'voice')],
  }),
  unconfirmed: receipt({
    message_id: 'send:t5',
    delivered_to: [],
    delivery: 'pending',
    channels: [{ channel_id: 'internal', status: 'unknown', detail: 'Send outcome is unknown; do not resend automatically.' }],
    attachments: [attachment(MEDIA.image, 'image')],
  }),
  failed: receipt({
    message_id: 'send:t6',
    delivered_to: [],
    delivery: 'undeliverable',
    channels: [
      { channel_id: 'internal', status: 'failed' },
      { channel_id: 'im:matrix-room', status: 'failed', detail: 'the room was not joined' },
    ],
  }),
};

const PROMPTS = [
  '把 0.31 的发布清单完整发我。',
  '封面、语音和清单文件一起发。',
  '这条只发到 Telegram。',
  '图和语音都发。',
  '这条发出去没有？',
  '再发一次。',
  '发个视频。',
];

function turnItem(turnId, prompt, steps, minutesAgo) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps,
  };
}

function step(turnId, frames, minutesAgo) {
  return {
    kind: 'step',
    stepId: `${turnId}.1`,
    turnId,
    ordinal: 1,
    state: 'completed',
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    frames,
  };
}

function sendFrame(turnId, output, minutesAgo, { state = 'done', text } = {}) {
  return {
    kind: 'tool',
    frameId: `t${turnId}-send`,
    toolCallId: `t${turnId}-send`,
    name: 'SendMessage',
    state,
    input: text === undefined ? { attachments: [] } : { text },
    output,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo),
  };
}

export default {
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
  ],
  personas: [{
    definition: {
      id: PERSONA.id, name: PERSONA.name, title: '发布协调',
      job: '负责每个版本的发布节奏：列清单、盯阻塞、写发布说明。',
      modelAlias: 'fixture/kiki-pro', thinkingEffort: 'high', delivery: 'message',
      description: '你是林岚，负责 Kiki 的发布协调。说话简短，先给结论。',
    },
  }],
  sessions: [sessionRecord(SID, {
    title: '0.31 发布清单',
    workspace_id: WS,
    delivery: 'message',
    metadata: { cwd: 'C:/fixture/bots/lin-lan', bot_persona_id: PERSONA.id },
    agent_config: { model: 'fixture/kiki-pro', persona: { id: PERSONA.id, name: PERSONA.name } },
  })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // Only the legacy turn's body is cut, through the production bounded-
      // content functions; every other body fits one frame.
      bounded_content: { frames: ['t1-send'] },
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          seq: 24,
          items: [
            turnItem('1', PROMPTS[0], [step('1', [sendFrame('1', RECEIPTS.legacy, 40, { text: LEGACY_BODY })], 40)], 40),
            turnItem('2', PROMPTS[1], [step('2', [sendFrame('2', RECEIPTS.delivered, 30, { text: LOCAL_DELIVERED })], 30)], 30),
            turnItem('3', PROMPTS[2], [step('3', [sendFrame('3', RECEIPTS.elsewhere, 22, { text: ELSEWHERE })], 22)], 22),
            turnItem('4', PROMPTS[3], [step('4', [sendFrame('4', RECEIPTS.partial, 15, { text: PARTIAL })], 15)], 15),
            turnItem('5', PROMPTS[4], [step('5', [sendFrame('5', RECEIPTS.unconfirmed, 9, { text: UNCONFIRMED })], 9)], 9),
            turnItem('6', PROMPTS[5], [step('6', [sendFrame('6', RECEIPTS.failed, 5, { text: ALL_FAILED })], 5)], 5),
            turnItem('7', PROMPTS[6], [step('7', [sendFrame('7', REFUSED_MEDIA, 2, { state: 'error' })], 2)], 2),
          ],
        },
      },
    },
  },
  // `/sessions/<id>/media/<blob id>` and its `/preview` serve these bytes.
  mediaFiles: Object.fromEntries(Object.values(MEDIA).map((media) => [
    media.id, {
      base64: media.bytes.toString('base64'), mime: media.mime, name: media.title,
      preview: media.preview, previewMime: media.previewMime,
    },
  ])),
  fsFiles: {
    'C:/fixture/bots/lin-lan/roadshow/index.html': { content: '<!doctype html><html><body><h1>MODIFIED ON HOST DISK</h1></body></html>', mime: 'text/html' },
    'C:/fixture/bots/lin-lan/roadshow/style.css': { content: HTML_CSS.toString('utf8'), mime: 'text/css' },
    'C:/fixture/bots/lin-lan/roadshow/app.js': { content: HTML_JS.toString('utf8'), mime: 'text/javascript' },
  },
  docPreviewPngBase64: COVER.toString('base64'),
};
