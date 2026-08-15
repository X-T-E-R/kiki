/**
 * Transcript — journal-style rendering of the session blocks: generous
 * whitespace, no assistant bubble (kiki mark + content), ink user cards,
 * collapsible thinking, tool cards, dark shell islands, amber interactions.
 *
 * Scroll runs on use-stick-to-bottom (codeg's message-thread pattern,
 * Apache-2.0): pinned to the bottom while streaming, "Jump to latest" pill
 * when the user scrolls up. Older history loads when scrolled to the top and
 * prepends with the viewport re-anchored (no jump) — the anchor dance
 * follows aionui's MessageList (Apache-2.0). Runs of ≥2 consecutive tool
 * blocks fold into a "Steps · N" group (aionui's MessageToolGroupSummary,
 * Apache-2.0; kiki auto-expands on error only, not while running).
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

import type { ApprovalDecision, QuestionAnswer } from '@moonshot-ai/protocol';

import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n/locale';
import {
  agentChildren,
  type AgentForest,
  type AgentTreeNode,
} from '../state/agentTree';
import {
  groupBlocks,
  groupHasError,
  groupHasRunning,
  groupToolNames,
  type DisplayNode,
  type ToolGroup,
} from '../state/grouping';
import type {
  AssistantBlock,
  Block,
  NoticeBlock,
  SessionViewState,
  ShellBlock,
  SkillBlock,
  SteerBlock,
  SubagentBlock,
  SystemBlock,
  SystemReminderBlock,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from '../state/transcript';
import { ApprovalCard, QuestionCard } from './Interactions';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { KikiMark, Wordmark } from './Wordmark';

/**
 * Split streaming assistant text into a settled prefix (safe to parse as
 * markdown — ends at a blank-line boundary with balanced code fences) and a
 * hot tail. The prefix re-parses only when it grows past another boundary;
 * the tail renders as plain text until a step/turn boundary settles the block
 * and the whole text upgrades to full markdown. This keeps live rendering off
 * the O(full-text) re-parse path the lexer benchmarks showed dominating
 * long streams.
 */
function splitStreamingText(text: string): { prefix: string; tail: string } {
  let cut = text.lastIndexOf('\n\n');
  while (cut > 0) {
    const prefix = text.slice(0, cut);
    if ((prefix.match(/```/g) ?? []).length % 2 === 0) {
      return { prefix, tail: text.slice(cut + 2) };
    }
    cut = text.lastIndexOf('\n\n', cut - 1);
  }
  return { prefix: '', tail: text };
}

const UserMessage = memo(function UserMessage({
  block,
  onCancelQueued,
}: {
  block: UserBlock;
  onCancelQueued?: (promptId: string) => void;
}) {
  const { t, time } = useI18n();
  return (
    <div className="anim-enter flex flex-col items-end" title={time.absoluteTime(block.createdAt)}>
      <span className="mb-1 flex items-baseline gap-1.5 pr-1">
        <span className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
          {t('transcript.you')}
        </span>
        <span className="text-xs text-ink-faint">{time.relativeTime(block.createdAt)}</span>
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-hairline bg-[#f3ede1] px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {block.text}
      </div>
      {block.promptStatus === 'queued' || block.promptStatus === 'blocked' ? (
        <span
          className={`mt-1 mr-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${
            block.promptStatus === 'queued'
              ? 'border-amber-rule/40 bg-amber-card text-amber-ink'
              : 'border-danger/30 bg-danger/5 text-danger'
          }`}
        >
          {block.promptStatus === 'queued' ? t('transcript.queuedChip') : t('transcript.blocked')}
          {block.promptStatus === 'queued' &&
          block.promptId !== undefined &&
          onCancelQueued !== undefined ? (
            <button
              type="button"
              aria-label={t('transcript.cancelQueuedAria')}
              title={t('transcript.cancelQueuedTitle')}
              onClick={() => { onCancelQueued(block.promptId!); }}
              className="rounded-full text-amber-ink/70 transition-colors hover:text-danger"
            >
              ×
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({ block }: { block: AssistantBlock }) {
  const { t, time } = useI18n();
  const [copied, setCopied] = useState(false);
  const streaming = block.streaming && block.text !== '';
  const { prefix, tail } = useMemo(
    () => (streaming ? splitStreamingText(block.text) : { prefix: '', tail: '' }),
    [streaming, block.text],
  );
  return (
    <div className="anim-enter group/msg relative flex gap-3" title={time.absoluteTime(block.createdAt)}>
      <KikiMark className="mt-[7px] shrink-0" />
      <div className="min-w-0 flex-1">
        {streaming ? (
          <>
            {prefix !== '' ? <Markdown text={prefix} /> : null}
            <div className="text-[14px] leading-[1.65] break-words whitespace-pre-wrap text-ink">
              {tail}
              <span className="stream-caret font-mono">▍</span>
            </div>
          </>
        ) : (
          <>
            <Markdown text={block.text} />
            {block.streaming ? <span className="stream-caret font-mono">▍</span> : null}
          </>
        )}
      </div>
      {!block.streaming && block.text !== '' ? (
        <button
          type="button"
          title={t('transcript.copyTitle')}
          onClick={() => {
            void navigator.clipboard
              .writeText(block.text)
              .then(() => {
                setCopied(true);
                setTimeout(() => { setCopied(false); }, 1400);
              })
              .catch(() => undefined);
          }}
          className={`absolute -top-1 right-0 rounded-md border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[10px] transition-opacity ${
            copied ? 'text-success opacity-100' : 'text-ink-faint opacity-0 group-hover/msg:opacity-100 hover:text-ink'
          }`}
        >
          {copied ? '✓' : t('transcript.copy')}
        </button>
      ) : null}
    </div>
  );
});

const ThinkingMessage = memo(function ThinkingMessage({ block }: { block: ThinkingBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-enter border-l-2 border-hairline-strong pl-3">
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        {t('transcript.thinking')}{block.streaming ? '…' : ''}
        {block.streaming ? <span className="stream-caret">▍</span> : null}
      </button>
      {open ? (
        <div className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft italic">
          {block.text}
        </div>
      ) : null}
    </div>
  );
});

/** Daemon-injected reminder peeled out of a user message — left lane, dimmed,
 * collapsed by default so the user's own bubble stays clean. */
const SystemReminderMessage = memo(function SystemReminderMessage({
  block,
}: {
  block: SystemReminderBlock;
}) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-enter border-l-2 border-dashed border-hairline pl-3" title={time.absoluteTime(block.createdAt)}>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint/80 transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        {t('transcript.systemReminder')}
      </button>
      {open ? (
        <div className="mt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {block.text}
        </div>
      ) : null}
    </div>
  );
});

const SYSTEM_VARIANT_KEYS = {
  injection: 'transcript.system.injection',
  system_trigger: 'transcript.system.trigger',
  compaction_summary: 'transcript.system.compaction',
  hook_result: 'transcript.system.hook',
  cron_job: 'transcript.system.cron',
  cron_missed: 'transcript.system.cronMissed',
  task: 'transcript.system.task',
  retry: 'transcript.system.retry',
  agent_message: 'transcript.system.agent',
  system: 'transcript.system.generic',
} as const;

const SystemMessage = memo(function SystemMessage({ block }: { block: SystemBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-enter border-l-2 border-hairline pl-3" title={time.absoluteTime(block.createdAt)}>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint/80 transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        {t(SYSTEM_VARIANT_KEYS[block.variant])}
      </button>
      {open ? (
        <div className="mt-1.5 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {block.text}
        </div>
      ) : null}
    </div>
  );
});

const SkillMessage = memo(function SkillMessage({ block }: { block: SkillBlock }) {
  const { t, time } = useI18n();
  const [open, setOpen] = useState(false);
  const title =
    block.source === 'plugin'
      ? t('transcript.skill.plugin', { name: block.name })
      : t('transcript.skill.skill', { name: block.name });
  return (
    <div className="anim-enter max-w-[85%] rounded-xl border border-hairline bg-panel px-3 py-2" title={time.absoluteTime(block.createdAt)}>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11.5px] font-medium text-ink-soft transition-colors hover:text-ink"
      >
        <span aria-hidden className={`inline-block text-[10px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="min-w-0 truncate">{title}</span>
        {block.args !== undefined && block.args !== '' ? (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-ink-faint">{block.args}</span>
        ) : null}
      </button>
      {open && block.text !== '' ? (
        <div className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft">
          {block.text}
        </div>
      ) : null}
    </div>
  );
});

const SteerMessage = memo(function SteerMessage({ block }: { block: SteerBlock }) {
  const { t, time } = useI18n();
  return (
    <div className="anim-enter flex flex-col items-start" title={time.absoluteTime(block.createdAt)}>
      <span className="mb-1 flex items-baseline gap-1.5 pl-1">
        <span className="rounded-full border border-accent/30 bg-accent-soft px-1.5 py-px text-[10px] font-semibold tracking-wide text-accent uppercase">
          {t('transcript.steerChip')}
        </span>
        <span className="text-xs text-ink-faint">{time.relativeTime(block.createdAt)}</span>
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-accent/20 bg-accent-soft/40 px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {block.text}
      </div>
    </div>
  );
});

const ShellMessage = memo(function ShellMessage({ block }: { block: ShellBlock }) {
  const { t } = useI18n();
  return (
    <div className="anim-enter overflow-hidden rounded-lg bg-ink">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] font-semibold text-accent">shell</span>
        {!block.done ? <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        {block.done && block.isError === true ? (
          <span className="font-mono text-[10.5px] text-danger">{t('transcript.failed')}</span>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#e8dcc4]">
        {block.output === '' ? '…' : block.output}
      </pre>
    </div>
  );
});

function useSubagentElapsed(block: SubagentBlock): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (block.endedAt !== undefined || block.status !== 'running') return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [block.endedAt, block.status]);
  const start = new Date(block.startedAt).getTime();
  const end = block.endedAt === undefined ? now : new Date(block.endedAt).getTime();
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

function subagentStatusTone(status: AgentTreeNode['status'] | SubagentBlock['status']): string {
  switch (status) {
    case 'running':
    case 'background':
      return 'bg-accent';
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-danger';
    case 'cancelled':
      return 'bg-ink-faint';
    default:
      return 'bg-amber-rule';
  }
}

function SubagentCardBody({
  name,
  model,
  status,
  toolCallCount,
  childCount,
  thinkingEffort,
  description,
  error,
  elapsed,
}: {
  name: string;
  model?: string;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  toolCallCount: number;
  childCount: number;
  thinkingEffort?: string;
  description?: string;
  error?: string;
  elapsed: number;
}) {
  const { t, tp, time } = useI18n();
  const busy = status === 'running' || status === 'background';
  return (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden className="font-mono text-[12px] text-accent">⧉</span>
        <span className={`h-2 w-2 rounded-full ${subagentStatusTone(status)} ${busy ? 'status-dot-busy' : ''}`} />
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{name}</span>
        {model !== undefined ? (
          <span className="shrink-0 rounded-full border border-hairline bg-paper px-1.5 py-px font-mono text-[9.5px] text-ink-soft">
            {model}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
          {time.formatDuration(elapsed)}
        </span>
        <span aria-hidden className="text-[10px] text-ink-faint transition-transform group-hover:translate-x-0.5">→</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-5 text-[10.5px] text-ink-faint">
        <span>{t(`subagent.status.${status}` as I18nKey)}</span>
        <span>·</span>
        <span>{tp('transcript.toolCalls', toolCallCount)}</span>
        {childCount > 0 ? (
          <>
            <span>·</span>
            <span>{tp('subagent.children', childCount)}</span>
          </>
        ) : null}
        {thinkingEffort !== undefined ? (
          <>
            <span>·</span>
            <span>{t('transcript.thinkingSuffix', { effort: thinkingEffort })}</span>
          </>
        ) : null}
      </div>
      {description !== undefined || error !== undefined ? (
        <p className={`mt-1 truncate pl-5 text-[11.5px] ${error !== undefined ? 'text-danger' : 'text-ink-soft'}`}>
          {error ?? description}
        </p>
      ) : null}
    </>
  );
}

const SubagentCard = memo(function SubagentCard({
  block,
  forest,
  depth = 0,
  childBlocks,
  onOpenAgent,
  displayStatus,
}: {
  block: SubagentBlock;
  forest?: AgentForest;
  depth?: number;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
  displayStatus?: AgentTreeNode['status'];
}) {
  const { t } = useI18n();
  const elapsed = useSubagentElapsed(block);
  const node = forest?.byId[block.subagentId];
  const children = forest === undefined ? [] : agentChildren(forest, block.subagentId);
  const hasActiveChild = children.some(
    (child) => child.status === 'running' || child.status === 'suspended' || child.status === 'background',
  );
  const status = displayStatus ?? node?.status ?? block.status;
  const [expanded, setExpanded] = useState(
    () => status === 'running' || status === 'suspended' || status === 'background' || hasActiveChild,
  );
  useEffect(() => {
    if (status === 'running' || status === 'suspended' || status === 'background' || hasActiveChild) {
      setExpanded(true);
    }
  }, [status, hasActiveChild]);
  const childCount = node?.childIds.length ?? children.length;
  const cardClass =
    'anim-enter group block w-full rounded-xl border border-hairline bg-panel/80 px-3 py-2.5 text-left transition-all hover:-translate-y-px hover:border-accent/50 hover:shadow-[0_8px_24px_-16px_rgba(28,25,23,0.35)]';
  const body = (
    <SubagentCardBody
      name={block.name}
      model={block.model}
      status={status}
      toolCallCount={block.toolCallCount}
      childCount={childCount}
      thinkingEffort={block.thinkingEffort}
      description={block.description}
      error={block.error}
      elapsed={elapsed}
    />
  );
  return (
    <div
      data-subagent-id={block.subagentId}
      data-agent-depth={depth}
      className={depth === 0 ? 'ml-6' : 'ml-4'}
    >
      <div className="flex items-stretch gap-1">
        {depth > 0 ? <span aria-hidden className="w-px shrink-0 bg-hairline" /> : null}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => { onOpenAgent?.(block.subagentId); }}
            data-agent-open={block.subagentId}
            className={cardClass}
          >
            {body}
          </button>
          {childCount > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((value) => !value);
              }}
              className="mt-1 rounded px-1.5 py-0.5 text-[10.5px] text-ink-faint transition-colors hover:text-accent"
            >
              {expanded ? t('subagent.collapseChildren') : t('subagent.expandChildren')}
            </button>
          ) : null}
          {expanded && children.length > 0 ? (
            <div className="mt-1 space-y-1">
              {children.map((child) => {
                const nested = childBlocks?.get(child.agentId) ?? syntheticChildBlock(child);
                return (
                  <SubagentCard
                    key={child.agentId}
                    block={nested}
                    forest={forest}
                    depth={depth + 1}
                    childBlocks={childBlocks}
                    onOpenAgent={onOpenAgent}
                    displayStatus={child.status}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function syntheticChildBlock(node: AgentTreeNode): SubagentBlock {
  const status: SubagentBlock['status'] =
    node.status === 'cancelled' || node.status === 'background' ? 'completed' : node.status;
  return {
    kind: 'subagent',
    id: `subagent-${node.agentId}`,
    subagentId: node.agentId,
    parentAgentId: node.parentAgentId,
    parentToolCallId: node.parentToolCallId,
    name: node.label,
    description: node.summary,
    model: node.model,
    thinkingEffort: node.thinkingEffort,
    status,
    summary: node.summary,
    error: node.error,
    startedAt: node.startedAt ?? '',
    endedAt: node.endedAt,
    toolCallCount: node.toolCallCount,
    transcript: [],
  };
}

const Notice = memo(function Notice({ block }: { block: NoticeBlock }) {
  const { t } = useI18n();
  const text = block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;
  if (block.tone === 'danger') {
    return (
      <div className="anim-enter rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 text-[12px] text-danger">
        {text}
      </div>
    );
  }
  return (
    <div className="anim-enter flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[11px] text-ink-faint">{text}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
});

/**
 * Folded tool run — aionui's group summary row, kiki rules: collapsed by
 * default, spinner while any tool runs, auto-expands on error only.
 */
const ToolGroupRow = memo(
  function ToolGroupRow({
    group,
    onOpenAgent,
  }: {
    group: ToolGroup;
    onOpenAgent?: (agentId: string) => void;
  }) {
  const { t } = useI18n();
  const running = groupHasRunning(group);
  const hasError = groupHasError(group);
  const [expanded, setExpanded] = useState(false);
  // Auto-expand on error (once per error arrival), never auto-collapse.
  useEffect(() => {
    if (hasError) setExpanded(true);
  }, [hasError]);

  return (
    <div className="anim-enter overflow-hidden rounded-xl border border-hairline bg-panel">
      <button
        type="button"
        onClick={() => { setExpanded((value) => !value); }}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-paper/60"
      >
        <span className="w-6 shrink-0 text-center font-mono text-[12px] text-ink-soft">☰</span>
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">
          {t('transcript.steps', { count: group.tools.length })}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {groupToolNames(group)}
        </span>
        {running ? (
          <svg className="spinner h-3.5 w-3.5 text-accent" viewBox="0 0 16 16" fill="none" aria-label={t('transcript.runningAria')}>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
            <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : hasError ? (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-danger/10 text-[10px] font-bold text-danger">×</span>
        ) : (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-success/10 text-[10px] font-bold text-success">✓</span>
        )}
        <span
          aria-hidden
          className={`shrink-0 text-[10px] text-ink-faint transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-hairline px-3 py-2.5">
          {group.tools.map((tool) => (
            <ToolCard key={tool.id} block={tool} onOpenAgent={onOpenAgent} />
          ))}
        </div>
      ) : null}
    </div>
  );
  },
  // groupBlocks rebuilds the wrapper per publish; the tool blocks themselves
  // keep identity, so element-wise comparison preserves the memo.
  (prev, next) =>
    prev.group.tools.length === next.group.tools.length &&
    prev.onOpenAgent === next.onOpenAgent &&
    prev.group.tools.every((tool, index) => tool === next.group.tools[index]),
);

const BlockView = memo(function BlockView({
  block,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onCancelQueued,
  agentNames,
  approvalShortcutHints,
  readOnly,
  forest,
  childBlocks,
  onOpenAgent,
}: {
  block: Exclude<Block, ToolBlock>;
  readOnly: boolean;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  /** subagentId → display name, for tagging child-origin interaction cards. */
  agentNames?: ReadonlyMap<string, string>;
  /** y/n shortcut hints show on every pending approval card. */
  approvalShortcutHints?: boolean;
  forest?: AgentForest;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const originUnknown =
    (block.kind === 'approval' || block.kind === 'question') && block.originUnknown === true;
  const originAgentName =
    !originUnknown &&
    (block.kind === 'approval' || block.kind === 'question') &&
    block.originAgentId !== undefined
      ? (agentNames?.get(block.originAgentId) ?? block.originAgentId)
      : undefined;
  const originFallback = originUnknown
    ? t(readOnly ? 'ia.originCurrentContext' : 'ia.originUnknown')
    : undefined;
  switch (block.kind) {
    case 'user':
      return <UserMessage block={block} onCancelQueued={readOnly ? undefined : onCancelQueued} />;
    case 'system-reminder':
      return <SystemReminderMessage block={block} />;
    case 'system':
      return <SystemMessage block={block} />;
    case 'skill':
      return <SkillMessage block={block} />;
    case 'steer':
      return <SteerMessage block={block} />;
    case 'assistant':
      return <AssistantMessage block={block} />;
    case 'thinking':
      return <ThinkingMessage block={block} />;
    case 'shell':
      return <ShellMessage block={block} />;
    case 'subagent':
      return <SubagentCard block={block} forest={forest} childBlocks={childBlocks} onOpenAgent={onOpenAgent} />;
    case 'notice':
      return <Notice block={block} />;
    case 'approval':
      return readOnly ? (
        <Notice
          block={{
            kind: 'notice',
            id: `${block.id}-readonly`,
            text: t('transcript.approvalReadonly', { action: block.request.action }),
            tone: 'neutral',
          }}
        />
      ) : (
        <ApprovalCard
          block={block}
          originAgentName={originAgentName ?? originFallback}
          showShortcutHints={approvalShortcutHints === true}
          onResolve={(decision, scope) => onResolveApproval(block.request.approval_id, decision, scope)}
        />
      );
    case 'question':
      return readOnly ? (
        <Notice
          block={{
            kind: 'notice',
            id: `${block.id}-readonly`,
            text: t('transcript.questionReadonly'),
            tone: 'neutral',
          }}
        />
      ) : (
        <QuestionCard
          block={block}
          originAgentName={originAgentName ?? originFallback}
          onAnswer={(answers) => onAnswerQuestion(block.request.question_id, answers)}
          onDismiss={() => onDismissQuestion(block.request.question_id)}
        />
      );
  }
});

function nodeKey(node: DisplayNode): string {
  return node.kind === 'tool-group' ? node.id : node.id;
}

/**
 * Jump-to-bottom pill — shown only when the user has scrolled up (codeg's
 * conditional centered pill driven by useStickToBottomContext).
 */
function JumpToBottom() {
  const { t } = useI18n();
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      onClick={() => void scrollToBottom()}
      className="anim-enter absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-panel/95 px-3 py-1.5 text-[11.5px] font-medium text-ink-soft shadow-[0_4px_16px_-6px_rgba(28,25,23,0.25)] transition-colors hover:border-accent hover:text-accent"
    >
      <span aria-hidden className="text-[10px]">▼</span> {t('transcript.jumpToLatest')}
    </button>
  );
}

/**
 * Top edge: fires `onLoadOlder` when the user scrolls near the top, then
 * re-anchors the viewport so the prepend doesn't shift the visible content
 * (aionui MessageList's record-height-then-restore dance, done with a
 * double rAF so React has committed the new blocks).
 */
function TopEdge({ state, onLoadOlder }: {
  state: SessionViewState;
  onLoadOlder: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { scrollRef } = useStickToBottomContext();
  const inflightRef = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onScroll = () => {
      if (
        inflightRef.current ||
        state.loadingOlder ||
        state.olderError !== undefined ||
        !state.hasMoreHistory ||
        element.scrollTop > 48
      ) {
        return;
      }
      inflightRef.current = true;
      const previousHeight = element.scrollHeight;
      const previousTop = element.scrollTop;
      void onLoadOlder().then((applied) => {
        inflightRef.current = false;
        if (!applied) return;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            element.scrollTop = element.scrollHeight - previousHeight + previousTop;
          });
        });
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); };
  }, [scrollRef, state.loadingOlder, state.hasMoreHistory, state.olderError, onLoadOlder]);

  if (state.loadingOlder) {
    return (
      <div className="flex items-center justify-center gap-2 pb-2 text-[11.5px] text-ink-faint">
        <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
        {t('transcript.loadingEarlier')}
      </div>
    );
  }
  if (state.olderError !== undefined) {
    return (
      <div className="flex flex-col items-center justify-center gap-1.5 pb-2 text-center">
        <p className="text-[11.5px] text-danger">{t('transcript.olderFailed')}</p>
        <p className="max-w-[360px] font-mono text-[10.5px] text-danger/80">{state.olderError}</p>
        <button
          type="button"
          onClick={() => { void onLoadOlder(); }}
          className="rounded-full border border-hairline px-2 py-0.5 text-[10.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-accent"
        >
          {t('transcript.retryEarlier')}
        </button>
      </div>
    );
  }
  if (!state.hasMoreHistory && state.fetchedOlder) {
    return (
      <div className="flex items-center gap-3 pb-1">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-[10.5px] text-ink-faint">{t('transcript.beginning')}</span>
        <span className="h-px flex-1 bg-hairline" />
      </div>
    );
  }
  return null;
}

export function Transcript({
  state,
  onLoadOlder,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onCancelQueued,
  onRetryLoad,
  readOnly = false,
  forest,
  onOpenAgent,
}: {
  state: SessionViewState;
  onLoadOlder: () => Promise<boolean>;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  onRetryLoad?: () => void;
  readOnly?: boolean;
  forest?: AgentForest;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const { blocks, loaded, loadError } = state;
  const nodes = useMemo(() => groupBlocks(blocks), [blocks]);
  const childBlocks = useMemo(() => {
    const map = new Map<string, SubagentBlock>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block);
    }
    return map;
  }, [blocks]);
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block.name);
    }
    if (forest !== undefined) {
      for (const node of Object.values(forest.byId)) {
        if (!map.has(node.agentId)) map.set(node.agentId, node.label);
      }
    }
    return map;
  }, [blocks, forest]);
  // y/n acts on the focused card, else the topmost visible pending card
  // (SessionView's resolver); every pending card advertises that shortcut.
  const hasUnresolvedApproval = useMemo(
    () => blocks.some((b) => b.kind === 'approval' && b.resolution === undefined),
    [blocks],
  );

  if (loadError !== undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <div className="max-w-[360px] rounded-xl border border-danger/30 bg-danger/5 p-4 text-center">
          <p className="text-[13px] font-medium text-danger">{t('transcript.couldNotOpen')}</p>
          <p className="mt-1 font-mono text-[11px] text-danger/80">{loadError}</p>
          {onRetryLoad !== undefined ? (
            <button
              type="button"
              onClick={onRetryLoad}
              className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-deep"
            >
              {t('common.retry')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-ink-faint">
        <span className="status-dot-busy h-2 w-2 rounded-full bg-accent" />
        {t('transcript.opening')}
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 opacity-70">
        <Wordmark size="lg" />
        <p className="text-[13px] text-ink-faint">{t('transcript.blank')}</p>
      </div>
    );
  }

  return (
    <StickToBottom
      className="relative min-h-0 flex-1"
      initial="instant"
      resize="smooth"
      role="log"
    >
      {/* Bottom clearance is 24px of breathing room + the 36px fade band the
          shell's active composer seat overlaps (see index.css), so the last
          block always rests fully above the fade. The column cap rides the
          shell's shared width axis. */}
      <StickToBottom.Content className="mx-auto flex max-w-[var(--kiki-chat-content-width,760px)] flex-col gap-4 px-6 pt-6 pb-[60px]">
        <TopEdge state={state} onLoadOlder={onLoadOlder} />
        {nodes.map((node) => (
          <div key={nodeKey(node)} data-block-id={nodeKey(node)}>
            {node.kind === 'tool-group' ? (
              <ToolGroupRow group={node} onOpenAgent={onOpenAgent} />
            ) : node.kind === 'tool' ? (
              <ToolCard block={node} onOpenAgent={onOpenAgent} />
            ) : (
              <BlockView
                block={node}
                onResolveApproval={onResolveApproval}
                onAnswerQuestion={onAnswerQuestion}
                onDismissQuestion={onDismissQuestion}
                onCancelQueued={onCancelQueued}
                agentNames={agentNames}
                approvalShortcutHints={hasUnresolvedApproval}
                readOnly={readOnly}
                forest={forest}
                childBlocks={childBlocks}
                onOpenAgent={onOpenAgent}
              />
            )}
          </div>
        ))}
      </StickToBottom.Content>
      <JumpToBottom />
    </StickToBottom>
  );
}
