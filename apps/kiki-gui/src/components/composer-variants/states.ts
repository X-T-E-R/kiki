/**
 * Mock composer surroundings for the variant prototypes. One flat record per
 * situation, covering every state the real composer area can be in (see the
 * inventory in README-free form below); the named combinations are what the
 * preview URL's `state=` picks.
 *
 * Inventory (source of each state in the real code):
 *   run            idle / working / compacting / waiting-on-you — SessionView
 *                  composerBusy + pendingInteraction, notice.compacting
 *   queue          parked prompts with timing, edit hold, steer — QueueStrip,
 *                  ComposerHeader, composer.sendNowHint (⌘/Ctrl+Enter)
 *   needsYou       approvals (incl. subagent origin, batch) and questions —
 *                  NeedsYouTray
 *   annotations    unsent (ride the next prompt) and sent — AnnotationTray
 *   attachments    images, files, uploads, reading placeholders — context tray
 *   draft          controlled per-session text
 *   context        meter ok / warn / danger, compaction running — ContextMeter
 *   connection     socket reconnecting / closed (App banner), transcript
 *                  resync / resync failed (ResyncStatusBanner), recovered
 *                  queue hold (RecoveryHoldBar)
 *   permission     manual / auto / review / yolo — PermissionSelect
 *   runMode        normal / plan / goal — RunModeChip, goal armed chip
 *   subagent       the endpoint composer in an agent tab ("回复 …")
 *   ephemeral      temporary conversation (in progress elsewhere)
 */

export type RunState = 'idle' | 'working' | 'compacting';
export type Connection = 'ok' | 'reconnecting' | 'offline' | 'resyncing';
export type QueueTiming = 'agent_idle' | 'subagents_done' | 'tasks_done';

export interface MockQueued {
  readonly id: string;
  readonly text: string;
  readonly timing?: QueueTiming;
  readonly attachments?: number;
}

export interface MockApproval {
  readonly id: string;
  readonly tool: string;
  readonly action: string;
  readonly command: string;
  readonly origin?: string;
}

export interface MockQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
}

export interface MockAnnotation {
  readonly id: string;
  readonly quote: string;
  readonly comment: string;
}

export interface MockAttachment {
  readonly kind: 'image' | 'file';
  readonly name: string;
  readonly size: number;
}

export interface ComposerMockState {
  readonly label: string;
  readonly run: RunState;
  /** Seconds the current turn has been running. */
  readonly elapsed?: number;
  /** Seconds since the agent last produced output. */
  readonly sinceResponse?: number;
  readonly queue: readonly MockQueued[];
  /** A prompt sent with "send now" that the running turn has not taken yet. */
  readonly steering?: string;
  /** Index of the queued prompt parked in the composer for editing. */
  readonly editingIndex?: number;
  readonly approvals: readonly MockApproval[];
  readonly questions: readonly MockQuestion[];
  readonly annotations: readonly MockAnnotation[];
  readonly sentAnnotations: number;
  readonly attachments: readonly MockAttachment[];
  readonly draft: string;
  /** Share of the usable context window, 0–100. */
  readonly context: number;
  readonly connection: Connection;
  readonly recoveredQueue?: number;
  readonly permission: 'manual' | 'auto' | 'review' | 'yolo';
  readonly plan: boolean;
  readonly subagent?: string;
  readonly ephemeral: boolean;
}

const BASE: ComposerMockState = {
  label: '',
  run: 'idle',
  queue: [],
  approvals: [],
  questions: [],
  annotations: [],
  sentAnnotations: 0,
  attachments: [],
  draft: '',
  context: 22,
  connection: 'ok',
  permission: 'auto',
  plan: false,
  ephemeral: false,
};

const Q1: MockQueued = { id: 'q1', text: '顺便把 paginate 的测试也跑一遍，失败的话贴出第一条断言。' };
const Q2: MockQueued = { id: 'q2', text: '跑完之后再看一下 sessionController 里 hasMore 的分支有没有覆盖到。', timing: 'subagents_done' };
const Q3: MockQueued = { id: 'q3', text: '最后整理一份改动清单给我。', attachments: 2 };
const Q4: MockQueued = { id: 'q4', text: '如果时间够，把 README 里分页那节也更新了，保持和服务端 page_size 上限一致，别再写死五十。' };

const APPROVAL: MockApproval = {
  id: 'a1',
  tool: 'Bash',
  action: '执行命令',
  command: 'pnpm vitest run packages/transcript --reporter=dot',
};
const APPROVAL_SUB: MockApproval = {
  id: 'a2',
  tool: 'Write',
  action: '写入文件',
  command: 'packages/transcript/src/pagination/paginate.ts',
  origin: 'reviewer',
};
const QUESTION: MockQuestion = {
  id: 'k1',
  question: '分页上限按服务端配置走，还是保留客户端的 50 作为兜底？',
  options: ['按服务端配置', '保留 50 兜底'],
};

const WORKING = { run: 'working', elapsed: 134, sinceResponse: 4 } as const;

export const STATES = {
  idle: { ...BASE, label: '空闲' },
  working: { ...BASE, ...WORKING, label: '只在工作' },
  'working-queue': { ...BASE, ...WORKING, label: '工作 + 排队', queue: [Q1, Q2] },
  'working-queue-approval': {
    ...BASE, ...WORKING, label: '工作 + 排队 + 待批准', queue: [Q1, Q2], approvals: [APPROVAL],
  },
  everything: {
    ...BASE,
    ...WORKING,
    label: '全部叠加',
    queue: [Q1, Q2, Q3, Q4],
    steering: '先别改 README，等我确认。',
    approvals: [APPROVAL, APPROVAL_SUB],
    questions: [QUESTION],
    annotations: [
      { id: 'n1', quote: '长会话打开时只取最近五十轮', comment: '这里的“五十轮”要和服务端上限对齐' },
      { id: 'n2', quote: '每页 20 轮', comment: '确认一下移动端也是 20' },
    ],
    sentAnnotations: 3,
    attachments: [
      { kind: 'image', name: 'timeline-top.png', size: 184_320 },
      { kind: 'file', name: 'paginate.ts', size: 6_144 },
    ],
    draft: '另外，压缩之后分页',
    context: 86,
    connection: 'reconnecting',
    permission: 'yolo',
    plan: true,
    ephemeral: true,
  },
  // ---- extra situations (overview sheet 2) ----
  'queue-one': { ...BASE, ...WORKING, label: '1 条排队', queue: [Q1] },
  'queue-many': { ...BASE, ...WORKING, label: '5 条排队', queue: [Q1, Q2, Q3, Q4, { id: 'q5', text: '收尾时提醒我发 PR。' }] },
  'queue-edit': { ...BASE, ...WORKING, label: '编辑排队中', queue: [Q1, Q2, Q3], editingIndex: 1, draft: Q2.text },
  steer: { ...BASE, ...WORKING, label: '立即插入中', steering: '先别改 README，等我确认。', queue: [Q2] },
  'idle-queue': { ...BASE, label: '空闲但排队在等', queue: [Q2], sinceResponse: 20 },
  question: { ...BASE, label: '待回答问题', questions: [QUESTION] },
  approvals: { ...BASE, label: '2 项待批准（含子智能体）', approvals: [APPROVAL, APPROVAL_SUB] },
  annotations: {
    ...BASE, label: '批注（未发 2 · 已发 3）',
    annotations: [
      { id: 'n1', quote: '长会话打开时只取最近五十轮', comment: '这里的“五十轮”要和服务端上限对齐' },
      { id: 'n2', quote: '每页 20 轮', comment: '确认一下移动端也是 20' },
    ],
    sentAnnotations: 3,
  },
  draft: {
    ...BASE, label: '草稿 + 附件',
    draft: '看一下这张截图里时间线顶部的空白是哪来的，\n顺便检查 paginate.ts 的游标。',
    attachments: [
      { kind: 'image', name: 'timeline-top.png', size: 184_320 },
      { kind: 'file', name: 'paginate.ts', size: 6_144 },
    ],
  },
  'context-full': { ...BASE, ...WORKING, label: '上下文快满', context: 91 },
  compacting: { ...BASE, run: 'compacting', elapsed: 18, label: '正在压缩', context: 93, queue: [Q1] },
  reconnecting: { ...BASE, ...WORKING, label: '重连中', connection: 'reconnecting', queue: [Q1] },
  offline: { ...BASE, label: '已断线', connection: 'offline', draft: '等连上了再发这条' },
  recovered: { ...BASE, label: '队列已恢复（待确认）', recoveredQueue: 2, queue: [Q1, Q2] },
  'plan-yolo': { ...BASE, label: '计划模式 + 完全放行', plan: true, permission: 'yolo' },
  subagent: { ...BASE, ...WORKING, label: '子智能体 tab', subagent: 'reviewer', queue: [Q1], approvals: [APPROVAL_SUB] },
  ephemeral: { ...BASE, label: '临时对话', ephemeral: true },
} satisfies Record<string, ComposerMockState>;

export type StateKey = keyof typeof STATES;

export const PRIMARY_STATES: readonly StateKey[] = [
  'idle', 'working', 'working-queue', 'working-queue-approval', 'everything',
];

export function stateFor(key: string): ComposerMockState {
  return (STATES as Record<string, ComposerMockState>)[key] ?? STATES.idle;
}

/** Everything that waits on the user, in the order it is handled. */
export function needsYouCount(state: ComposerMockState): number {
  return state.approvals.length + state.questions.length;
}

/** `2:14` / `18 秒` style elapsed label. */
export function elapsedLabel(seconds: number | undefined, zh: boolean): string {
  if (seconds === undefined) return '';
  if (seconds < 60) return zh ? `${seconds} 秒` : `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}
