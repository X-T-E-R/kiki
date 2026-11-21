/**
 * extreme-dirty-transcript — F9 realistic heavy fixture: 220 turns mixing CJK
 * prose, wide Markdown tables, long fenced code blocks, tool-error records, and
 * attachment references so visual/scroll/pagination gates face real-world dirty
 * transcripts rather than sterile 64-turn ASCII toys.
 */

import {
  assistantMsg,
  commitAssistant,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  userMsg,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_extreme_dirty';

const LONG_CODE = `\`\`\`ts
export interface MobileViewportMetrics {
  readonly viewport: { width: number; height: number; dpr: number };
  readonly coldBootMs: number;
  readonly firstMessagePaintMs: number;
  readonly longTaskMaxMs: number;
  readonly totalBlockingTimeMs: number;
}

export function computeThrottlePenalty(baseMs: number, cpuRate = 4, rttMs = 40): number {
  let acc = baseMs * cpuRate;
  for (let i = 0; i < 6; i += 1) {
    acc += rttMs * 0.5;
  }
  return Math.round(acc);
}
\`\`\``;

const CJK_TOPICS = [
  '手机端首屏加载卡顿与 0% 压缩 JS 包体排查',
  'iOS 软键盘 visualViewport.offsetTop 顶栏偏移回归',
  '横屏灵动岛 safe-area-inset-left 遮挡左侧栏',
  '500+ 子代理并发流式输出与虚拟列表重排',
  '弱网 Tailscale 40ms RTT 下重复 snapshot RPC 瀑布',
  '多空间切换后未读小红点粘滞与空状态异常',
];

const older = [];
const recent = [];
const TOTAL_TURNS = 220;

for (let i = 0; i < TOTAL_TURNS; i += 1) {
  const topic = CJK_TOPICS[i % CJK_TOPICS.length];
  const minutesAgo = (TOTAL_TURNS - i) * 2;
  const userText =
    i % 11 === 0
      ? `[Attachment: mobile-trace-${i + 1}.json (184 KiB)] 第 ${i + 1} 轮：请核查 ${topic}，并给出精确行号与实测毫秒数据。`
      : `Turn ${i + 1} / 第 ${i + 1} 轮：请分析「${topic}」在弱网与 4x CPU 下的真实表现。`;
  const user = userMsg(SID, userText, minutesAgo);

  const parts = [
    `关于「${topic}」（第 ${i + 1} 轮复盘）：不要只看桌面 127.0.0.1 数据，必须实测真实 \`kap-server\` \`webAssets\` 与移动视口。`,
  ];
  if (i % 7 === 0) {
    parts.push(
      `\n\n> [Tool Error] \`ETIMEDOUT\` fetching \`/api/klient/session-view/${SID}/snapshot\` after 817ms (retry #1 succeeded).`,
    );
  }
  if (i % 5 === 2) {
    parts.push(`\n\n${LONG_CODE}`);
  }
  if (i % 9 === 3) {
    parts.push(
      `\n\n| 指标 | 桌面回环 | 手机 4x CPU + 40ms RTT |\n| --- | ---: | ---: |\n| Cold Boot | 480 ms | 7266 ms |\n| Heavy TTFM | 290 ms | 1805 ms |\n| Scroll P95 | 16.7 ms | 66.7 ms |`,
    );
  }
  const assistant = assistantMsg(SID, parts, Math.max(0, minutesAgo - 1));
  (i < TOTAL_TURNS - 25 ? older : recent).push(user, assistant);
}

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: extreme dirty CJK + errors + attachments (220 turns)',
      message_count: TOTAL_TURNS * 2,
    }),
  ],
  snapshots: {
    [SID]: { messages: recent, has_more: true, older },
  },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    ...streamSteps('assistant.delta', 1, '已确认极端脏语料 220 轮回放与增量流式输出正常。', { per: 20 }),
    turnEnd(1),
    commitAssistant('$SID', '已确认极端脏语料 220 轮回放与增量流式输出正常。'),
    {
      frame: {
        type: 'prompt.completed',
        payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' },
      },
    },
    workChanged(false),
  ],
};
