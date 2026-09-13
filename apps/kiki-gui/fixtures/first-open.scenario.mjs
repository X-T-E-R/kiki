import zlib from 'node:zlib';

import { assistantMsg, fid, originMsg, sessionRecord, ts, userMsg } from './helpers.mjs';

const SID = 'session_fixture_first_open';

/**
 * First-open geometry scenario: mirrors the real session shape that showed
 * the overlap report — a long user prompt carrying screenshots, tool results
 * with image outputs (ReadMediaFile), a pile of background-task completion
 * notifications with one failure, and long markdown answers with code fences.
 * Images are real PNG data URIs (the served-history contract resolves blobref
 * to data URIs), large enough that decode cost is real.
 */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** Screenshot-like PNG: UI-ish blocks with per-pixel noise so deflate keeps real size. */
function makePng(width, height, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  let state = seed;
  const rnd = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let y = 0; y < height; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const block = ((x >> 4) + (y >> 4)) % 2 === 0 ? 238 : 248;
      raw[p++] = Math.max(0, Math.min(255, block + ((rnd() * 46) | 0) - 23));
      raw[p++] = Math.max(0, Math.min(255, block + ((rnd() * 46) | 0) - 23));
      raw[p++] = Math.max(0, Math.min(255, ((y / height) * 210 + rnd() * 30) | 0));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const SHOT_A = `data:image/png;base64,${makePng(1440, 900, 7).toString('base64')}`;
const SHOT_B = `data:image/png;base64,${makePng(1280, 800, 42).toString('base64')}`;
const SHOT_C = `data:image/png;base64,${makePng(1024, 768, 99).toString('base64')}`;

const LONG_PROMPT = [
  '先通读最近的任务记录与交接文档，然后逐项解决下面这些问题。',
  '',
  '1. 默认主配置档在设置页里的地位需要显式提升：要展示在列表中，并且基于实际可用的条目列出它能派生的子代理；当前切换配置档会报错，导致无法正常发消息。',
  '2. 后台任务的通知有时候会堆积成一串，全部摊在时间线里，非常吵。成功的合并起来，失败的必须保留可见。',
  '3. 已决的审批、问题、目标/计划标记不应该占大片区域；我想在时间线原位置看到它们存在过，但以紧凑形式。',
  '4. 历史子代理经常显示 0 次工具调用，但我明明看到它跑了很多工具。计数要以权威来源为准，旧的快照不应该把新值抬回去。',
  '5. 子代理卡片换思路：只有运行中的用大卡片，其余全部改成小条并且可以连续合并。',
  '6. 从工具卡片上应该能跳转到对应子代理的详情页，跳转后要能定位到那张卡片。',
  '7. 子代理右侧栏可能过长：描述、摘要、错误信息需要折叠逻辑；子代理的子代理要用树形直观展示。',
  '8. 首开或者切换到子代理页面时偶尔出现行重叠或者巨大的空白，图片加载完之后尤其明显。',
  '',
  '截图在这里，先看图再逐项给方案:',
].join('\n');

const CODE_ANSWER = [
  '逐项给结论。先看投影层的核心段落:',
  '',
  '```ts',
  'export function groupHistoryRuns(nodes, isCompact) {',
  '  const out = [];',
  '  let run = [];',
  '  const flush = () => {',
  '    if (run.length >= 2) out.push({ kind: "history-run", id: `history-run-${run[0].id}`, nodes: run });',
  '    else out.push(...run);',
  '    run = [];',
  '  };',
  '  for (const node of nodes) {',
  '    if (isCompact(node)) { run.push(node); continue; }',
  '    flush();',
  '    out.push(node);',
  '  }',
  '  flush();',
  '  return out;',
  '}',
  '```',
  '',
  '要点:连续的紧凑节点折叠成一条摘要行;任何非紧凑节点(用户消息、待决交互、失败项)都会断开分组,所以折叠永远不会跨过你的发言,也不会吞掉失败。',
  '',
  '计数权威链的修正:',
  '',
  '```ts',
  'export function resolveSubagentToolCalls(block, node) {',
  '  if (node?.toolCallCountKnown === true) return { count: node.toolCallCount, known: true };',
  '  if (node?.toolCallCountKnown === false) return { count: node.toolCallCount, known: false };',
  '  // …块声明兜底,都没有则兼容旧数据',
  '}',
  '```',
  '',
  '森林节点每次子代理更新都会重投影,可能把计数向下修正;父时间线的块只保留投影时的快照,不会被重投。所以节点声明必须赢过块。',
].join('\n');

function taskNotification(text, taskId, minutesAgo) {
  return originMsg(SID, text, { kind: 'task', taskId }, minutesAgo);
}

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: first open overlap' })],
  snapshots: {
    [SID]: {
      has_more: false,
      messages: [
        {
          id: fid('msg'),
          session_id: SID,
          role: 'user',
          content: [
            { type: 'text', text: LONG_PROMPT },
            { type: 'image', source: { kind: 'url', url: SHOT_A } },
            { type: 'image', source: { kind: 'url', url: SHOT_B } },
          ],
          created_at: ts(50),
        },
        assistantMsg(SID, ['先把链路拆开:服务端投影、传输、前端投影三层。我查几个关键文件。', { toolUse: { id: 'call-read-1', name: 'Read', input: { path: 'packages/session-core/src/session/transcript/project.ts' } } }], 49),
        assistantMsg(SID, [{ toolUse: { id: 'call-media-1', name: 'ReadMediaFile', input: { path: 'C:/fixture/shots/overlap.png' } } }], 48),
        {
          id: fid('msg'),
          session_id: SID,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: 'call-media-1',
              output: [
                { type: 'text', text: '<image path="C:/fixture/shots/overlap.png">' },
                { type: 'image_url', imageUrl: { url: SHOT_C } },
                { type: 'text', text: '</image>' },
              ],
            },
          ],
          created_at: ts(48),
        },
        assistantMsg(SID, [CODE_ANSWER], 47),
        // Background-task notification pile: four successes in a row (fold),
        // then one failure (stays individually visible).
        taskNotification('Background agent completed\n搜索配置复用 completed.', 'task_n1', 46),
        taskNotification('Background agent completed\n索引重建 completed.', 'task_n2', 45),
        taskNotification('Background agent completed\n文档同步 completed.', 'task_n3', 44),
        taskNotification('Background agent completed\n截图比对 completed.', 'task_n4', 43),
        taskNotification('Background agent failed\nProvider returned 403: quota exhausted.', 'task_n5', 42),
        userMsg(SID, '结论先给我一句话版本。', 41),
        assistantMsg(SID, ['一句话:重叠与空白都来自同一次测高窗口里的估算值没有及时被真实高度替换;修复是把折叠与计数权威厘清,测高路径用真实图片回归。'], 40),
      ],
    },
  },
};
