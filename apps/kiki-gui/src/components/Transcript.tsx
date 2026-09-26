/**
 * Transcript — journal-style rendering of the session blocks: generous
 * whitespace, no assistant bubble (kiki mark + content), ink user cards,
 * collapsible thinking, tool cards, dark shell islands, amber interactions.
 *
 * The variable-height block list is windowed with TanStack Virtual. Its
 * end-anchor is the single owner of append follow, streaming growth, prepend
 * anchoring, and full-measurement reset restoration. Runs of ≥2 consecutive
 * tool blocks fold into a "Steps · N" group (aionui's
 * MessageToolGroupSummary, Apache-2.0; kiki auto-expands on error only, not
 * while running).
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from 'react';
import { parseMarkdownIntoBlocks } from 'streamdown';
import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';

import type { ApprovalDecision, QuestionAnswer } from '@kiki/protocol';

import type { I18nKey } from '@kiki/session-core/i18n';
import {
  applyAnnotationOverrides,
  collectTimelineAnnotations,
  getAnnotationOverridesSnapshot,
  subscribeAnnotationOverrides,
  writeAnnotationOverride,
  type AnnotationOverride,
  type TimelineAnnotation,
} from '@kiki/session-core/composer';
import {
  subscribeSettings,
  settingsServerSnapshot,
  settingsSnapshot,
} from '@kiki/session-core/settings';
import {
  agentChildren,
  groupBlocks,
  groupHasError,
  groupHasRunning,
  groupToolNames,
  latestFinalAssistantBlockId,
  stabilizeAgentForest,
  type AgentForest,
  type AgentTreeNode,
  type AssistantBlock,
  type Block,
  type DisplayNode,
  type NoticeBlock,
  type SessionViewState,
  type ShellBlock,
  type SkillBlock,
  type SubagentBlock,
  type SubagentEventBlock,
  type SystemBlock,
  type SystemReminderBlock,
  type ThinkingBlock,
  type ToolBlock,
  type ToolGroup,
  type TurnExecutionInfo,
  type TurnRetryInfo,
  type TurnTailInfo,
  type UserBlock,
} from '@kiki/session-core/session';
import { formatTokensPerSecond } from '@kiki/session-core/util';
import { useI18n } from '../i18n';
import { copyTextToClipboard } from '../lib/clipboard';
import { useCollapsibleOverflow } from '../lib/collapsibleOverflow';
import {
  groupHistoryRuns,
  HistoryLine,
  HistoryRunRow,
  historyRunsEqual,
  isInterruptionNotice,
  isMarkerNotice,
  isTerminalPromptNotice,
  type GroupedDisplayNode,
} from './ActivityHistory';
import { AnnotationPopover, type AnnotationPopoverOpen } from './AnnotationPopover';
import { FloorNavRail } from './FloorNavRail';
import { ApprovalCard, QuestionCard } from './Interactions';
import { Markdown } from './Markdown';
import { projectTextWithAnnotationMarks } from './markdown/annotationMarks';
import { MediaPartList } from './mediaPreview';
import { RelativeTime } from './RelativeTime';
import { MessageRowActions, UserMessageEditor } from './RowActions';
import { resolveSubagentToolCalls, type SubagentToolCalls } from './subagentToolCalls';
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
export function splitStreamingText(text: string): { prefix: string; tail: string } {
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

/**
 * Reference/footnote definitions (`[label]: target`) register document-level
 * symbols: a definition in one block rewrites inline links in every other
 * block, so block-local parsing is unsafe when one is present. Same rule as
 * pi-tui's markdown block cache (packages/pi-tui/src/components/markdown.ts).
 * Rare in assistant output — the prefix then stays one document.
 */
const REFERENCE_DEFINITION_LINE = /^ {0,3}\[[^\n]*\]:/m;

/** Chunks up to this size keep per-delta memo-skip reconciliation short. */
const STREAMING_SEGMENT_TARGET = 2000;

/**
 * Split a settled streaming prefix into independently parseable chunks.
 *
 * Boundaries come from `parseMarkdownIntoBlocks` (marked's top-level token
 * boundaries — the same splitter Streamdown itself uses), NOT from character
 * scanning: a fence (``` or ~~~), a loose list, or a blockquote that spans
 * blank lines is a single token and therefore never split. Blocks are exact
 * source slices (they join back to the input verbatim), so small blocks are
 * coalesced into chunks of up to ~2k chars by plain concatenation, and a
 * growing stream only ever extends the final chunk — earlier chunk strings
 * stay referentially stable, which is what makes the per-chunk Markdown
 * memo effective.
 *
 * Reference definitions are the one cross-block construct tokenization
 * cannot isolate; when present, the whole prefix stays a single chunk (the
 * pre-segmentation behavior — correct, just slower for that rare stream).
 */
export function splitPrefixSegments(prefix: string): string[] {
  if (REFERENCE_DEFINITION_LINE.test(prefix)) return [prefix];
  const blocks = parseMarkdownIntoBlocks(prefix);
  if (blocks.length <= 1) return blocks;
  const chunks: string[] = [];
  let chunk = '';
  for (const block of blocks) {
    if (chunk !== '' && chunk.length + block.length > STREAMING_SEGMENT_TARGET) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += block;
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

/**
 * Decorate `@subagent` tokens in user prose as accent chips
 * (deepseek-harness's projectUserText, MIT — token shape only, no
 * lexicon). Presentation-only: every slice comes from the original string at
 * exact offsets, so selection/copy keeps the verbatim text.
 *
 * Slash-looking tokens are deliberately NOT chipped: a leading `/` is plain
 * prose unless the submit-time command resolution matched a registered
 * skill/command (that path renders from the activation record as a SkillBlock
 * instead), so text shape alone is never sufficient evidence for a skill
 * label.
 */
export function projectUserText(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/(^|\s)(@[\w-]+)(?=\s|$)/g)) {
    const tokenStart = match.index + (match[1]?.length ?? 0);
    const label = match[2] ?? '';
    if (tokenStart > cursor) parts.push(text.slice(cursor, tokenStart));
    parts.push(
      <span
        key={tokenStart}
        data-ref-chip="subagent"
        className="rounded-md border border-accent/30 bg-accent-soft px-1 py-px font-mono text-[11.5px] text-accent"
      >
        {label}
      </span>,
    );
    cursor = tokenStart + label.length;
  }
  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/**
 * Row-level action surface handed down from SessionView. Absent on read-only
 * or subagent transcripts — no hover actions render there.
 */
export interface TranscriptRowActions {
  /** Turn running / resyncing: mutating actions render but disable. */
  disabled: boolean;
  onEditMessage: (block: UserBlock, text: string) => void;
  onRegenerate: (block: AssistantBlock) => void;
  onFork: (block: UserBlock | AssistantBlock) => void;
}

const UserMessage = memo(function UserMessage({
  block,
  onCancelQueued: _onCancelQueued,
  rowActions,
  annotations,
}: {
  block: UserBlock;
  onCancelQueued?: (promptId: string) => void;
  rowActions?: TranscriptRowActions;
  /** Timeline annotations anchored to this message's text (identity-stable). */
  annotations?: readonly TimelineAnnotation[];
}) {
  const { t, time } = useI18n();
  const [editing, setEditing] = useState(false);
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(block.text);
  const clipped = !expanded;
  // Edit/fork need the stable wire identity; parked prompts settle through
  // the queue strip instead of a rewrite.
  const settled = block.promptStatus === undefined;
  const canMutate = rowActions !== undefined && block.userMessageId !== undefined && settled;
  const agentMessageLabel =
    block.agentMessage === undefined
      ? undefined
      : block.agentMessage.senderAgentId === 'main'
        ? t('agentMessage.fromMain')
        : t('agentMessage.fromAgent', {
            name:
              block.agentMessage.senderTaskName ??
              block.agentMessage.senderAgentId ??
              t('agentMessage.agent'),
          });
  const peerThreadLabel =
    block.peerThread === undefined
      ? undefined
      : t('agentMessage.fromThread', { id: block.peerThread.sessionId ?? '?' });
  const senderLabel = agentMessageLabel ?? peerThreadLabel;
  return (
    <div className="anim-enter group/msg flex flex-col items-end" title={time.absoluteTime(block.createdAt)}>
      <span className="mb-1 flex items-baseline gap-1.5 pr-1">
        {rowActions !== undefined && !editing ? (
          <MessageRowActions
            copyText={block.text}
            canEdit={canMutate}
            canFork={canMutate}
            disabled={rowActions.disabled}
            onEdit={() => { setEditing(true); }}
            onFork={() => { rowActions.onFork(block); }}
          />
        ) : null}
        <span
          data-agent-message-sender={block.agentMessage?.senderAgentId}
          data-peer-thread={block.peerThread?.sessionId}
          className="text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase"
        >
          {senderLabel ?? t('transcript.you')}
        </span>
        <span className="text-xs text-ink-faint"><RelativeTime at={block.createdAt} /></span>
      </span>
      {block.media !== undefined ? <div className="mb-1.5"><MediaPartList media={block.media} align="end" /></div> : null}
      {editing && rowActions !== undefined ? (
        <UserMessageEditor
          initialText={block.text}
          onSubmit={(text) => {
            setEditing(false);
            rowActions.onEditMessage(block, text);
          }}
          onCancel={() => { setEditing(false); }}
        />
      ) : (
        <div className="max-w-[85%] rounded-2xl rounded-br-md border border-hairline bg-bubble-user px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
          <div
            ref={contentRef}
            id={contentId}
            data-collapsible-content
            className={
              clipped
                ? `max-h-60 overflow-hidden${isOverflowing ? ' collapsed-content-fade' : ''}`
                : undefined
            }
          >
            {annotations === undefined || annotations.length === 0
              ? projectUserText(block.text)
              : projectTextWithAnnotationMarks(block.text, annotations, projectUserText)}
          </div>
        </div>
      )}
      {!editing && isOverflowing ? (
        <button
          type="button"
          data-collapsible-toggle
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="mt-1 mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-ink-faint transition-colors hover:text-accent"
        >
          {expanded ? t('transcript.showLess') : t('transcript.showMore')}
          <span aria-hidden className="text-[9px]">{expanded ? '▴' : '▾'}</span>
        </button>
      ) : null}
      {block.optimisticStatus !== undefined ? (
        <span role="status" data-optimistic-status={block.optimisticStatus} className="mt-1 mr-1 text-[10.5px] text-ink-faint">
          {t(block.optimisticStatus === 'slow' ? 'transcript.stillSending' : 'transcript.sending')}
        </span>
      ) : null}
      {block.promptStatus === 'blocked' ? (
        <span className="mt-1 mr-1 flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/5 px-2 py-0.5 text-[10.5px] font-medium text-danger">
          {t('transcript.blocked')}
        </span>
      ) : null}
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  block,
  rowActions,
  isLatestFinal = false,
  annotations,
}: {
  block: AssistantBlock;
  rowActions?: TranscriptRowActions;
  /** Latest completed turn's final reply — the regenerate/fork anchor. */
  isLatestFinal?: boolean;
  /** Timeline annotations anchored to this message's text (identity-stable). */
  annotations?: readonly TimelineAnnotation[];
}) {
  const { t, time } = useI18n();
  const streaming = block.streaming && block.text !== '';
  const { prefix, tail } = useMemo(
    () => (streaming ? splitStreamingText(block.text) : { prefix: '', tail: '' }),
    [streaming, block.text],
  );
  const segments = useMemo(
    () => (streaming && prefix !== '' ? splitPrefixSegments(prefix) : []),
    [streaming, prefix],
  );
  const showActions =
    !block.streaming &&
    (block.text !== '' || (rowActions !== undefined && isLatestFinal));
  return (
    <div className="anim-enter group/msg relative flex gap-3" title={time.absoluteTime(block.createdAt)}>
      <KikiMark className="mt-[7px] shrink-0" />
      <div className="min-w-0 flex-1">
        {streaming ? (
          <>
            {segments.length > 0 ? (
              <div className="kiki-md-segments">
                {segments.map((segment, index) => (
                  <Markdown key={index} text={segment} preserveEdgeMargins />
                ))}
              </div>
            ) : null}
            <div className="text-[14px] leading-[1.65] break-words whitespace-pre-wrap text-ink">
              {tail}
              <span className="stream-caret font-mono">▍</span>
            </div>
          </>
        ) : (
          <>
            {/* Marks ride the settled render only: a streaming block's text
                still moves under the quote, and a quote split across the
                memoized prefix chunks would silently lose its mark anyway. */}
            {block.text !== '' ? <Markdown text={block.text} annotationTargets={annotations} /> : null}
            {block.streaming ? <span className="stream-caret font-mono">▍</span> : null}
          </>
        )}
        {block.media !== undefined ? <MediaPartList media={block.media} /> : null}
        {block.stopped === true ? (
          <span className="mt-1 inline-flex items-center gap-1 rounded-md border border-hairline bg-paper px-1.5 py-px text-[10.5px] font-medium text-ink-faint">
            <span aria-hidden className="text-[9px]">■</span>
            {t('transcript.stopped')}
          </span>
        ) : null}
      </div>
      {showActions ? (
        <MessageRowActions
          framed
          copyText={block.text}
          canRegenerate={rowActions !== undefined && isLatestFinal}
          canFork={rowActions !== undefined && isLatestFinal}
          disabled={rowActions?.disabled ?? false}
          onRegenerate={() => { rowActions?.onRegenerate(block); }}
          onFork={() => { rowActions?.onFork(block); }}
        />
      ) : null}
    </div>
  );
});

function firstLineOf(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

function latestLineOf(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf('\n');
  return newline === -1 ? visible : visible.slice(newline + 1);
}

const ThinkingMessage = memo(function ThinkingMessage({ block }: { block: ThinkingBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // deepseek-harness's ReasoningRow summary rule: while tokens are streaming
  // the collapsed line tracks the LATEST line; once settled it pins the first.
  const summary = block.streaming ? latestLineOf(block.text) : firstLineOf(block.text);
  return (
    <div
      className="thinking-row anim-enter border-l-2 border-hairline-strong pl-3"
      data-streaming={block.streaming || undefined}
    >
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="shrink-0">{t('transcript.thinking')}{block.streaming ? '…' : ''}</span>
        {block.streaming ? <span className="stream-caret shrink-0">▍</span> : null}
        {summary !== '' ? (
          <span className="min-w-0 flex-1 truncate font-normal text-ink-faint/70 italic">{summary}</span>
        ) : null}
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
        <div className="mt-1.5 max-h-[140px] overflow-auto pr-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
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
    <div data-system={block.variant} className="anim-enter border-l-2 border-hairline pl-3" title={time.absoluteTime(block.createdAt)}>
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-medium text-ink-faint/80 transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="shrink-0">{t(SYSTEM_VARIANT_KEYS[block.variant])}</span>
        {block.source !== undefined ? (
          <span className="min-w-0 truncate font-normal text-ink-faint/60">· {block.source}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-1.5 max-h-[140px] overflow-auto pr-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-faint">
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
    <div
      data-skill
      className="anim-enter max-w-full border-l-2 border-hairline-strong py-0.5 pl-2.5"
      title={time.absoluteTime(block.createdAt)}
    >
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        className="flex max-w-full items-center gap-1.5 text-left text-[11px] font-medium text-ink-faint transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block text-[9px] transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        <span className="min-w-0 truncate">{title}</span>
        {block.args !== undefined && block.args !== '' ? (
          <span className="min-w-0 truncate font-mono text-[10px] font-normal text-ink-faint/70">{block.args}</span>
        ) : null}
      </button>
      {open && block.text !== '' ? (
        <div className="mt-1 max-h-36 overflow-auto pr-2 text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink-faint">
          {block.text}
        </div>
      ) : null}
    </div>
  );
});

const ShellMessage = memo(function ShellMessage({ block }: { block: ShellBlock }) {
  const { t } = useI18n();
  // Collapsed by default — running and finished alike (the full log was
  // eating the timeline). The header keeps the status and the command, while
  // the latest output line remains a separate muted preview.
  const [open, setOpen] = useState(false);
  const preview = latestLineOf(block.output);
  return (
    <div data-shell className="anim-enter overflow-hidden rounded-lg bg-shell">
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        aria-expanded={open}
        aria-label={open ? t('transcript.showLess') : t('transcript.showMore')}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span
          aria-hidden
          className={`inline-block shrink-0 text-[9px] text-shell-ink-soft transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        >
          ▶
        </span>
        <span className="shrink-0 font-mono text-[11px] font-semibold text-accent">shell</span>
        {!block.done ? (
          <span className="status-dot-busy h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        ) : null}
        {block.done && block.isError === true ? (
          <span className="shrink-0 font-mono text-[10.5px] text-danger">{t('transcript.failed')}</span>
        ) : null}
        {block.command !== undefined ? (
          <span
            data-shell-command-preview
            title={block.command}
            className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-shell-ink-strong"
          >
            <span className="mr-1 text-accent">$ </span>
            {block.command}
          </span>
        ) : null}
        {!open && preview !== '' ? (
          <span
            className={`min-w-0 truncate font-mono text-[10.5px] text-shell-ink-soft ${
              block.command === undefined ? 'flex-1' : 'max-w-[42%] border-l border-white/10 pl-2'
            }`}
          >
            {preview}
          </span>
        ) : null}
      </button>
      {open && block.command !== undefined ? (
        <div
          data-shell-command-full
          className="border-t border-white/10 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words text-shell-ink-strong"
        >
          <span className="mr-2 text-accent">$ </span>
          {block.command}
        </div>
      ) : null}
      {open ? (
        <pre className="max-h-80 overflow-auto border-t border-white/10 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-shell-ink">
          {block.output === '' ? '…' : block.output}
        </pre>
      ) : null}
    </div>
  );
});

/**
 * Parse an ISO timeline timestamp that may be absent (undefined / the
 * legacy '' sentinel) or unparseable; undefined means "unknown", never 0.
 */
function parseTimelineMs(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Elapsed time for a subagent card. undefined when either end is genuinely
 * unknown (the card then shows an explicit "—" instead of a fabricated 0ms);
 * a live run ticks against the live clock. The forest node is the
 * authoritative source for the CURRENT run (a resume re-stamps its timing);
 * the block's frozen dispatch snapshot is only the fallback, and its stale
 * endedAt must never pin a live run at 0ms.
 */
function useSubagentElapsed(
  block: SubagentBlock,
  node: AgentTreeNode | undefined,
  status: AgentTreeNode['status'] | SubagentBlock['status'],
): number | undefined {
  const live = status === 'running' || status === 'background' || status === 'suspended';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { clearInterval(timer); };
  }, [live]);
  const start = parseTimelineMs(node?.startedAt) ?? parseTimelineMs(block.startedAt);
  if (start === undefined) return undefined;
  const end = live ? now : (parseTimelineMs(node?.endedAt) ?? parseTimelineMs(block.endedAt));
  if (end === undefined) return undefined;
  return Math.max(0, end - start);
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
    case 'unknown':
      return 'bg-ink-faint';
    case 'suspended':
      return 'bg-amber-rule';
  }
}

function SubagentCardBody({
  name,
  model,
  status,
  toolCallCount,
  toolCallCountKnown,
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
  /** false = neither the task nor the roster ever reported a count. */
  toolCallCountKnown: boolean;
  childCount: number;
  thinkingEffort?: string;
  description?: string;
  error?: string;
  /** undefined = start or end unknown — rendered as an explicit "—". */
  elapsed: number | undefined;
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
        <span
          className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint"
          title={elapsed === undefined ? t('transcript.durationUnknown') : undefined}
        >
          {elapsed === undefined ? '—' : time.formatDuration(elapsed)}
        </span>
        <span aria-hidden className="text-[10px] text-ink-faint transition-transform group-hover:translate-x-0.5">→</span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-5 text-[10.5px] text-ink-faint">
        <span>{t(`subagent.status.${status}` as I18nKey)}</span>
        <span>·</span>
        <span>{toolCallCountKnown ? tp('transcript.toolCalls', toolCallCount) : t('diagnostics.unknown')}</span>
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
        <p
          title={error}
          className={`mt-1 truncate pl-5 text-[11.5px] ${error !== undefined ? 'text-danger' : 'text-ink-soft'}`}
        >
          {error ?? description}
        </p>
      ) : null}
    </>
  );
}

/**
 * Manual form override for a subagent card: once the user expands or
 * collapses a card by hand the automatic rule (active run → full, terminal →
 * compact) no longer touches that card.
 */
export type SubagentCardForm = 'full' | 'compact';

/**
 * Automatic card form: only a genuinely active run (running / background)
 * earns the full card. Completed, suspended and unknown runs stay compact
 * one-liners — a completed parent whose own child still runs does NOT
 * inflate; the child carries its own card.
 */
export function subagentAutoForm(
  status: AgentTreeNode['status'] | SubagentBlock['status'],
): SubagentCardForm {
  return status === 'running' || status === 'background' ? 'full' : 'compact';
}

/**
 * Compact collapsed form of a subagent card (terminal runs land here by
 * default): one row with status dot, name, terminal status, result summary,
 * duration and tool count. Click jumps to the agent page; the trailing
 * chevron expands back to the full card (manual override).
 */
function SubagentCompactCard({
  block,
  status,
  error,
  summary,
  elapsed,
  depth,
  toolCalls,
  onOpenAgent,
  onExpand,
}: {
  block: SubagentBlock;
  status: AgentTreeNode['status'] | SubagentBlock['status'];
  /** Terminal-run error for the current run; undefined while a live run is active. */
  error: string | undefined;
  /** Result summary, live-node first with the frozen block as fallback. */
  summary: string | undefined;
  elapsed: number | undefined;
  depth: number;
  toolCalls: SubagentToolCalls;
  onOpenAgent?: (agentId: string) => void;
  onExpand?: () => void;
}) {
  const { t, tp, time } = useI18n();
  const line = error ?? summary;
  return (
    <div
      data-subagent-id={block.subagentId}
      data-agent-depth={depth}
      data-card-form="compact"
      data-orphaned={block.orphaned === true || undefined}
      className={`${depth === 0 ? 'ml-6' : 'ml-4'}${block.orphaned === true ? ' opacity-60' : ''}`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => { onOpenAgent?.(block.subagentId); }}
          data-agent-open={block.subagentId}
          className="anim-enter group flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline bg-panel/60 px-2.5 py-1.5 text-left transition-colors hover:border-accent/50"
        >
          <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${subagentStatusTone(status)}`} />
          <span className="shrink-0 text-[12px] font-medium text-ink">{block.name}</span>
          <span className="shrink-0 text-[10.5px] text-ink-faint">
            {t(`subagent.status.${status}` as I18nKey)}
          </span>
          {line !== undefined ? (
            <span
              title={error}
              className={`min-w-0 flex-1 truncate text-[11px] ${error !== undefined ? 'text-danger' : 'text-ink-soft'}`}
            >
              {line}
            </span>
          ) : (
            <span className="min-w-0 flex-1" />
          )}
          <span
            className="shrink-0 font-mono text-[10px] text-ink-faint"
            title={elapsed === undefined ? t('transcript.durationUnknown') : undefined}
          >
            {elapsed === undefined ? '—' : time.formatDuration(elapsed)}
          </span>
          <span className="shrink-0 text-[10px] text-ink-faint">
            {toolCalls.known ? tp('transcript.toolCalls', toolCalls.count) : t('diagnostics.unknown')}
          </span>
          <span aria-hidden className="shrink-0 text-[10px] text-ink-faint transition-transform group-hover:translate-x-0.5">→</span>
        </button>
        {onExpand !== undefined ? (
          <button
            type="button"
            data-card-expand={block.subagentId}
            aria-label={t('subagent.expandCard')}
            title={t('subagent.expandCard')}
            onClick={onExpand}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] text-ink-faint transition-colors hover:bg-paper hover:text-accent"
          >
            ▸
          </button>
        ) : null}
      </div>
    </div>
  );
}

const SubagentCard = memo(function SubagentCard({
  block,
  forest,
  depth = 0,
  childBlocks,
  onOpenAgent,
  displayStatus,
  formOverride,
  onToggleForm,
}: {
  block: SubagentBlock;
  forest?: AgentForest;
  depth?: number;
  childBlocks?: ReadonlyMap<string, SubagentBlock>;
  onOpenAgent?: (agentId: string) => void;
  displayStatus?: AgentTreeNode['status'];
  formOverride?: SubagentCardForm;
  onToggleForm?: (agentId: string, form: SubagentCardForm) => void;
}) {
  const { t } = useI18n();
  const node = forest?.byId[block.subagentId];
  const children = forest === undefined ? [] : agentChildren(forest, block.subagentId);
  const status = displayStatus ?? node?.status ?? block.status;
  const elapsed = useSubagentElapsed(block, node, status);
  const runIsLive = status === 'running' || status === 'background' || status === 'suspended';
  // The forest node tracks the CURRENT run (a resume re-stamps model, effort
  // and timing and clears the terminal error); the block is a frozen dispatch
  // snapshot. Live values win; the block is the fallback when no node exists.
  const model = node?.model ?? block.model;
  const thinkingEffort = node?.thinkingEffort ?? block.thinkingEffort;
  const runError = runIsLive ? undefined : (node?.error ?? block.error);
  const runSummary = node?.summary ?? block.summary;
  // Only a genuinely active run owns the full card; a completed parent whose
  // child still runs stays compact — the child has its own card.
  const active = subagentAutoForm(status) === 'full';
  const full = formOverride !== undefined ? formOverride === 'full' : active;
  const [expanded, setExpanded] = useState(() => active);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  const childCount = node?.childIds.length ?? children.length;
  const toolCalls = resolveSubagentToolCalls(block, node);
  if (!full) {
    return (
      <SubagentCompactCard
        block={block}
        status={status}
        error={runError}
        summary={runSummary}
        elapsed={elapsed}
        depth={depth}
        toolCalls={toolCalls}
        onOpenAgent={onOpenAgent}
        onExpand={
          onToggleForm === undefined
            ? undefined
            : () => { onToggleForm(block.subagentId, 'full'); }
        }
      />
    );
  }
  const cardClass =
    'anim-enter group flex items-start gap-1 rounded-xl border border-hairline bg-panel/80 px-3 py-2.5 transition-all hover:-translate-y-px hover:border-accent/50 hover:shadow-[0_8px_24px_-16px_rgba(28,25,23,0.35)]';
  const body = (
    <SubagentCardBody
      name={block.name}
      model={model}
      status={status}
      toolCallCount={toolCalls.count}
      toolCallCountKnown={toolCalls.known}
      childCount={childCount}
      thinkingEffort={thinkingEffort}
      description={block.description}
      error={runError}
      elapsed={elapsed}
    />
  );
  return (
    <div
      data-subagent-id={block.subagentId}
      data-agent-depth={depth}
      data-card-form="full"
      data-orphaned={block.orphaned === true || undefined}
      className={`${depth === 0 ? 'ml-6' : 'ml-4'}${block.orphaned === true ? ' opacity-60' : ''}`}
    >
      <div className="flex items-stretch gap-1">
        {depth > 0 ? <span aria-hidden className="w-px shrink-0 bg-hairline" /> : null}
        <div className="min-w-0 flex-1">
          <div className={cardClass}>
            <button
              type="button"
              onClick={() => { onOpenAgent?.(block.subagentId); }}
              data-agent-open={block.subagentId}
              className="min-w-0 flex-1 text-left"
            >
              {body}
            </button>
            {onToggleForm !== undefined ? (
              <button
                type="button"
                data-card-collapse={block.subagentId}
                aria-label={t('subagent.collapseCard')}
                title={t('subagent.collapseCard')}
                onClick={() => { onToggleForm(block.subagentId, 'compact'); }}
                className="-mt-0.5 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] text-ink-faint transition-colors hover:bg-paper hover:text-accent"
              >
                ▾
              </button>
            ) : null}
          </div>
          {block.orphaned === true ? (
            <p className="mt-1 pl-1 text-[10.5px] text-ink-faint italic">
              {t('transcript.orphanedSubagent')}
            </p>
          ) : null}
          {childCount > 0 ? (
            <div className="flex items-center gap-1">
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
            </div>
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

function agentMessageSummary(message: string, limit = 140): string {
  const compact = message.replaceAll(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * One-line lifecycle entry (G-4 compact form): status dot + name + event +
 * relative time; the whole row jumps to the agent page. Rows sit in place at
 * their event timestamp among the regular transcript blocks.
 */
const SubagentEventRow = memo(function SubagentEventRow({
  block,
  onOpenAgent,
}: {
  block: SubagentEventBlock;
  onOpenAgent?: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const busy = block.status === 'running' || block.status === 'suspended';
  const isFailed = block.event === 'failed' || block.status === 'failed';
  const messageSummary = block.message === undefined ? undefined : agentMessageSummary(block.message);
  return (
    <div className="ml-6">
      <button
        type="button"
        onClick={() => { onOpenAgent?.(block.subagentId); }}
        data-subagent-event={block.subagentId}
        data-agent-event={block.event}
        data-agent-open={block.subagentId}
        title={block.error ?? t('subagent.openAgent', { name: block.name })}
        className={`anim-enter group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${
          isFailed ? 'hover:bg-danger/10' : 'hover:bg-panel'
        }`}
      >
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${subagentStatusTone(block.status)} ${busy ? 'status-dot-busy' : ''}`}
        />
        <span className={`shrink-0 text-[11.5px] font-medium ${isFailed ? 'text-danger' : 'text-ink-soft'}`}>{block.name}</span>
        <span className={`shrink-0 text-[10.5px] ${isFailed ? 'text-danger font-medium' : 'text-ink-faint'}`}>
          {t(`subagent.event.${block.event}` as I18nKey)}
        </span>
        {messageSummary === undefined ? null : (
          <span
            data-agent-message-summary
            title={block.message}
            className="min-w-0 flex-1 truncate text-[10.5px] text-ink-soft"
          >
            {messageSummary}
          </span>
        )}
        {block.delivery === undefined ? null : (
          <span
            data-agent-message-delivery={block.delivery}
            className={`shrink-0 rounded-full border px-1.5 py-px text-[9.5px] font-medium ${
              block.delivery === 'queued'
                ? 'border-amber-rule/40 bg-amber-card text-amber-ink'
                : 'border-success/30 bg-success/5 text-success'
            }`}
          >
            {t(block.delivery === 'queued' ? 'agentMessage.pending' : 'agentMessage.delivered')}
          </span>
        )}
        {block.error !== undefined ? (
          <span
            title={block.error}
            className="min-w-0 flex-1 truncate text-[10.5px] text-danger"
          >
            {block.error}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-faint">
          {block.at === undefined ? '' : <RelativeTime at={block.at} />}
        </span>
        <span aria-hidden className="shrink-0 text-[9.5px] text-ink-faint transition-transform group-hover:translate-x-0.5">→</span>
      </button>
    </div>
  );
});

function syntheticChildBlock(node: AgentTreeNode): SubagentBlock {
  const status: SubagentBlock['status'] =
    node.status === 'background' ? 'running' : node.status;
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
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    toolCallCount: node.toolCallCount,
    transcript: [],
  };
}

const Notice = memo(function Notice({ block }: { block: NoticeBlock }) {
  const { t, time } = useI18n();
  const text = block.i18n !== undefined ? t(block.i18n.key, block.i18n.params) : block.text;
  const title = time.absoluteTime(block.createdAt);
  if (block.tone === 'danger') {
    return (
      <div
        data-notice-tone={block.tone}
        title={title}
        className="anim-enter rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 text-[12px] text-danger"
      >
        {text}
      </div>
    );
  }
  return (
    <div data-notice-tone={block.tone} title={title} className="anim-enter flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[11px] text-ink-faint">{text}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
});

/**
 * Folded step run — aionui's group summary row, kiki rules: collapsed by
 * default, spinner while any member runs, auto-expands on error only. The
 * row folds tool calls, shell runs and thinking into one compact block; the
 * summary shows the step count, tool names and the real framed durations
 * (unknown timings never fabricate a total).
 */
const ToolGroupRow = memo(
  function ToolGroupRow({
    group,
    agentId,
    agentNames,
    onOpenAgent,
  }: {
    group: ToolGroup;
    agentId: string;
    agentNames?: ReadonlyMap<string, string>;
    onOpenAgent?: (agentId: string) => void;
  }) {
  const { t, time } = useI18n();
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
        aria-expanded={expanded}
        aria-label={t('transcript.stepsAria')}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-paper/60"
      >
        <span className="w-6 shrink-0 text-center font-mono text-[12px] text-ink-soft">☰</span>
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">
          {t('transcript.steps', { count: group.count })}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {groupToolNames(group)}
        </span>
        {!running && !hasError && group.durationMs !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">
            {time.formatDuration(group.durationMs)}
          </span>
        ) : null}
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
          {/* Members render in ORIGINAL occurrence order — never the per-kind
              aggregations, so Read → shell → thinking → Edit stays in the
              order it happened. */}
          {group.members.map((member) =>
            member.kind === 'tool' ? (
              <ToolCard key={member.id} block={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
            ) : member.kind === 'shell' ? (
              <ShellMessage key={member.id} block={member} />
            ) : member.kind === 'thinking' ? (
              <ThinkingMessage key={member.id} block={member} />
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
  },
  // groupBlocks rebuilds the wrapper per publish; the step blocks themselves
  // keep identity, so element-wise comparison preserves the memo. Every
  // ordered member compares — the aggregations alone would miss a shell
  // turning failed or a thinking block's streaming text.
  (prev, next) =>
    prev.agentId === next.agentId &&
    prev.group.members.length === next.group.members.length &&
    prev.group.members.every((member, index) => member === next.group.members[index]) &&
    prev.group.durationMs === next.group.durationMs &&
    prev.group.startedAt === next.group.startedAt &&
    prev.agentNames === next.agentNames &&
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
  subagentFormOverride,
  onToggleSubagentForm,
  onOpenAgent,
  rowActions,
  latestFinalAssistantId,
  annotations,
}: {
  block: Exclude<Block, ToolBlock>;
  readOnly: boolean;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
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
  subagentFormOverride?: SubagentCardForm;
  onToggleSubagentForm?: (agentId: string, form: SubagentCardForm) => void;
  onOpenAgent?: (agentId: string) => void;
  rowActions?: TranscriptRowActions;
  latestFinalAssistantId?: string;
  annotations?: readonly TimelineAnnotation[];
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
  const liveRowActions = readOnly ? undefined : rowActions;
  switch (block.kind) {
    case 'user':
      return (
        <UserMessage
          block={block}
          onCancelQueued={readOnly ? undefined : onCancelQueued}
          rowActions={liveRowActions}
          annotations={annotations}
        />
      );
    case 'system-reminder':
      return <SystemReminderMessage block={block} />;
    case 'system':
      return <SystemMessage block={block} />;
    case 'skill':
      return <SkillMessage block={block} />;
    case 'assistant':
      return (
        <AssistantMessage
          block={block}
          rowActions={liveRowActions}
          isLatestFinal={block.id === latestFinalAssistantId}
          annotations={annotations}
        />
      );
    case 'thinking':
      return <ThinkingMessage block={block} />;
    case 'shell':
      return <ShellMessage block={block} />;
    case 'subagent':
      return (
        <SubagentCard
          block={block}
          forest={forest}
          childBlocks={childBlocks}
          onOpenAgent={onOpenAgent}
          formOverride={subagentFormOverride}
          onToggleForm={onToggleSubagentForm}
        />
      );
    case 'subagent-event':
      return <SubagentEventRow block={block} onOpenAgent={onOpenAgent} />;
    case 'notice':
      return <Notice block={block} />;
    case 'approval':
      // Terminal facts stay inline as one compact history line (readOnly or
      // not); only a PENDING approval keeps the full interactive card.
      return block.resolution !== undefined ? (
        <HistoryLine node={block} originName={originAgentName ?? originFallback} />
      ) : readOnly ? (
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
          onResolve={(decision, scope, selectedOptionId) =>
            onResolveApproval(block.request.approval_id, decision, scope, selectedOptionId)
          }
        />
      );
    case 'question':
      return block.outcome !== undefined ? (
        <HistoryLine node={block} originName={originAgentName ?? originFallback} />
      ) : readOnly ? (
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

/** Turn a display node belongs to (tool groups take their first tool's). */
function displayNodeTurnId(node: GroupedDisplayNode): string | undefined {
  if (node.kind === 'history-run') {
    const first = node.nodes[0];
    return first === undefined ? undefined : displayNodeTurnId(first);
  }
  if (node.kind === 'tool-group') return node.tools[0]?.turnId;
  return 'turnId' in node ? node.turnId : undefined;
}

/**
 * Background-task terminal notifications project as `system` blocks (variant
 * 'task') whose text leads with the producer's title line — `Background agent
 * failed`, a format agent-core owns — or, for stripped-XML history, carries a
 * `Severity: warning` header line. Successes may fold; failures must not.
 */
function isFailedTaskNotificationText(text: string): boolean {
  const firstLine = text.split('\n', 1)[0] ?? '';
  return (
    /^(?:Title:\s*)?Background \S+ (?:failed|timed_out|killed|lost)\b/.test(firstLine) ||
    /^Severity:\s*warning\s*$/m.test(text)
  );
}

function isCompactHistoryNode(
  node: DisplayNode,
  forest: AgentForest | undefined,
  cardForms: ReadonlyMap<string, SubagentCardForm>,
  visibleTailTurnId: string | undefined,
): boolean {
  switch (node.kind) {
    case 'approval':
      return node.resolution !== undefined;
    case 'question':
      return node.outcome !== undefined;
    case 'notice':
      if (
        visibleTailTurnId !== undefined &&
        node.turnId === visibleTailTurnId &&
        (isTerminalPromptNotice(node) || isInterruptionNotice(node))
      ) {
        return false;
      }
      return isMarkerNotice(node) || isTerminalPromptNotice(node);
    case 'system':
      return (
        node.variant === 'cron_job' ||
        (node.variant === 'task' && !isFailedTaskNotificationText(node.text))
      );
    case 'subagent-event':
      return (
        node.event === 'spawned' ||
        node.event === 'resumed' ||
        node.event === 'sent' ||
        node.event === 'completed'
      );
    case 'subagent': {
      const status = forest?.byId[node.subagentId]?.status ?? node.status;
      const form = cardForms.get(node.subagentId) ?? subagentAutoForm(status);
      return (
        form === 'compact' &&
        status !== 'failed' &&
        status !== 'cancelled' &&
        node.error === undefined
      );
    }
    default:
      return false;
  }
}

function groupedNodeKey(node: GroupedDisplayNode): string {
  return node.kind === 'history-run' ? node.id : nodeKey(node);
}

/**
 * Derived-map identity stabilization: the maps Transcript passes to every
 * row (childBlocks, agentNames) are rebuilt from a fresh scan each render —
 * cheap, since the reducer structurally shares unchanged blocks — but the
 * PREVIOUS map object is returned while every entry is identical, so
 * memoized rows see referentially stable props across streaming deltas and
 * only the touched block re-renders. (Render-phase identity cache — the
 * "latest equal value" pattern; safe here because the transcript subtree is
 * never rendered concurrently with a conflicting cache writer.)
 */
function useStableMap<K, V>(build: () => Map<K, V>): ReadonlyMap<K, V> {
  const ref = useRef<ReadonlyMap<K, V> | null>(null);
  const next = build();
  const prev = ref.current;
  if (prev !== null && prev.size === next.size) {
    let identical = true;
    for (const [key, value] of next) {
      if (prev.get(key) !== value) {
        identical = false;
        break;
      }
    }
    if (identical) return prev;
  }
  ref.current = next;
  return next;
}

function annotationListsEqual(
  previous: readonly TimelineAnnotation[] | undefined,
  next: readonly TimelineAnnotation[],
): previous is readonly TimelineAnnotation[] {
  return (
    previous !== undefined &&
    previous.length === next.length &&
    previous.every((annotation, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        annotation.id === candidate.id &&
        annotation.quote === candidate.quote &&
        annotation.comment === candidate.comment
      );
    })
  );
}

function useStableAnnotationTargets(
  next: ReadonlyMap<string, readonly TimelineAnnotation[]>,
): ReadonlyMap<string, readonly TimelineAnnotation[]> {
  const ref = useRef<ReadonlyMap<string, readonly TimelineAnnotation[]> | null>(null);
  const previous = ref.current;
  let allIdentical = previous !== null && previous.size === next.size;
  const stable = new Map<string, readonly TimelineAnnotation[]>();
  for (const [blockId, annotations] of next) {
    const previousList = previous?.get(blockId);
    if (annotationListsEqual(previousList, annotations)) {
      stable.set(blockId, previousList);
    } else {
      stable.set(blockId, annotations);
      allIdentical = false;
    }
  }
  if (allIdentical && previous !== null) return previous;
  ref.current = stable;
  return stable;
}

/**
 * Content-level identity stabilization for the forest prop. SessionView
 * rebuilds the agent forest from the whole session state on every publish;
 * structurally sharing unchanged branches keeps historical roster rows and
 * transcript cards memo-stable even when a different agent changes.
 */
export function useStableForest<T extends AgentForest | undefined>(forest: T): T {
  const ref = useRef<AgentForest | undefined>(undefined);
  if (forest === undefined) {
    ref.current = undefined;
    return forest;
  }
  const stable = stabilizeAgentForest(ref.current, forest);
  ref.current = stable;
  return stable as T;
}

function displayNodesEqual(a: DisplayNode, b: DisplayNode): boolean {
  if (a === b) return true;
  // groupBlocks rebuilds the ToolGroup wrapper per publish while the step
  // blocks inside keep identity — compare every ordered member element-wise
  // (same rule as ToolGroupRow's own memo comparator): the tool list alone
  // would miss a shell turning failed or a thinking block's streaming text.
  if (a.kind === 'tool-group' && b.kind === 'tool-group') {
    return (
      a.id === b.id &&
      a.members.length === b.members.length &&
      a.members.every((member, index) => member === b.members[index])
    );
  }
  return false;
}

const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 120;
const TRANSCRIPT_OVERSCAN = 6;
const TRANSCRIPT_END_THRESHOLD = 80;
const EMPTY_TRANSCRIPT_ITEM_KEY = 'transcript-live-status';

type TranscriptVirtualNode = GroupedDisplayNode | undefined;
type TranscriptViewportAnchor = {
  atEnd: boolean;
  key: string | undefined;
  offset: number;
};

type PendingResetRestore = {
  version: number;
  anchor: TranscriptViewportAnchor;
  frame: number | null;
};

function virtualNodeKey(node: TranscriptVirtualNode): string {
  return node === undefined ? EMPTY_TRANSCRIPT_ITEM_KEY : groupedNodeKey(node);
}

function measureTranscriptRow(element: HTMLDivElement, entry: ResizeObserverEntry | undefined): number {
  return Math.round(entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight);
}

function captureTranscriptAnchor(
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>,
): TranscriptViewportAnchor {
  const scrollOffset = virtualizer.scrollOffset ?? virtualizer.scrollElement?.scrollTop ?? 0;
  const item = virtualizer.getVirtualItemForOffset(scrollOffset);
  return {
    atEnd: virtualizer.isAtEnd(TRANSCRIPT_END_THRESHOLD),
    key: typeof item?.key === 'string' ? item.key : undefined,
    offset: item === undefined ? 0 : scrollOffset - item.start,
  };
}

type TranscriptRowProps = {
  node: GroupedDisplayNode;
  agentId: string;
  readOnly: boolean;
  approvalShortcutHints: boolean;
  agentNames: ReadonlyMap<string, string>;
  childBlocks: ReadonlyMap<string, SubagentBlock>;
  forest?: AgentForest;
  rowActions?: TranscriptRowActions;
  latestFinalAssistantId?: string;
  annotations?: readonly TimelineAnnotation[];
  /** External-executor badge shown above the first row of the turn. */
  executionBadge?: TurnExecutionInfo;
  /** Manual subagent card form overrides, keyed by subagentId (empty = auto). */
  subagentFormOverrides: ReadonlyMap<string, SubagentCardForm>;
  onToggleSubagentForm?: (agentId: string, form: SubagentCardForm) => void;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  onOpenAgent?: (agentId: string) => void;
};

function nodeUsesAgentNames(node: GroupedDisplayNode): boolean {
  return (
    node.kind === 'approval' ||
    node.kind === 'question' ||
    node.kind === 'tool' ||
    node.kind === 'tool-group' ||
    node.kind === 'history-run'
  );
}

function subagentBranchEqual(
  node: GroupedDisplayNode,
  previousForest: AgentForest | undefined,
  nextForest: AgentForest | undefined,
): boolean {
  if (node.kind === 'history-run') {
    return node.nodes.every((member) => subagentBranchEqual(member, previousForest, nextForest));
  }
  if (node.kind !== 'subagent') return true;
  return previousForest?.byId[node.subagentId] === nextForest?.byId[node.subagentId];
}

/**
 * One transcript row. This memo boundary is what keeps a streaming delta
 * from re-rendering the whole tree: the reducer preserves block identity
 * for untouched blocks, so with stable map/callback props a delta re-renders
 * only the row whose block actually changed.
 */
const TranscriptRow = memo(
  function TranscriptRow({
    node,
    agentId,
    readOnly,
    approvalShortcutHints,
    agentNames,
    childBlocks,
    forest,
    rowActions,
    latestFinalAssistantId,
    annotations,
    executionBadge,
    subagentFormOverrides,
    onToggleSubagentForm,
    onResolveApproval,
    onAnswerQuestion,
    onDismissQuestion,
    onCancelQueued,
    onOpenAgent,
  }: TranscriptRowProps) {
    // data-turn-id makes a turn addressable from outside the transcript (the
    // /usage drilldown's ?turn= locator scrolls to it); absent on turn-less
    // nodes, so the attribute simply doesn't render there.
    const rowTurnId = displayNodeTurnId(node);
    const renderNode = (member: DisplayNode): ReactNode =>
      member.kind === 'tool-group' ? (
        <ToolGroupRow group={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
      ) : member.kind === 'tool' ? (
        <ToolCard block={member} agentId={agentId} agentNames={agentNames} onOpenAgent={onOpenAgent} />
      ) : (
        <BlockView
          block={member}
          onResolveApproval={onResolveApproval}
          onAnswerQuestion={onAnswerQuestion}
          onDismissQuestion={onDismissQuestion}
          onCancelQueued={onCancelQueued}
          agentNames={agentNames}
          approvalShortcutHints={approvalShortcutHints}
          readOnly={readOnly}
          forest={forest}
          childBlocks={childBlocks}
          subagentFormOverride={
            member.kind === 'subagent' ? subagentFormOverrides.get(member.subagentId) : undefined
          }
          onToggleSubagentForm={onToggleSubagentForm}
          onOpenAgent={onOpenAgent}
          rowActions={rowActions}
          latestFinalAssistantId={latestFinalAssistantId}
          annotations={member.id === node.id ? annotations : undefined}
        />
      );
    if (node.kind === 'history-run') {
      return (
        <div data-block-id={node.id} data-turn-id={rowTurnId}>
          {executionBadge !== undefined ? <TurnExecutionBadge execution={executionBadge} /> : null}
          <HistoryRunRow run={node} renderMember={renderNode} />
        </div>
      );
    }
    return (
      <div data-block-id={nodeKey(node)} data-turn-id={rowTurnId}>
        {executionBadge !== undefined ? <TurnExecutionBadge execution={executionBadge} /> : null}
        {renderNode(node)}
      </div>
    );
  },
  (prev, next) =>
    (displayNodesEqual(prev.node as DisplayNode, next.node as DisplayNode) ||
      historyRunsEqual(prev.node, next.node)) &&
    prev.agentId === next.agentId &&
    prev.readOnly === next.readOnly &&
    prev.approvalShortcutHints === next.approvalShortcutHints &&
    (!nodeUsesAgentNames(prev.node) || prev.agentNames === next.agentNames) &&
    subagentBranchEqual(prev.node, prev.forest, next.forest) &&
    prev.rowActions === next.rowActions &&
    prev.latestFinalAssistantId === next.latestFinalAssistantId &&
    prev.annotations === next.annotations &&
    prev.executionBadge === next.executionBadge &&
    prev.subagentFormOverrides === next.subagentFormOverrides &&
    prev.onToggleSubagentForm === next.onToggleSubagentForm &&
    prev.onResolveApproval === next.onResolveApproval &&
    prev.onAnswerQuestion === next.onAnswerQuestion &&
    prev.onDismissQuestion === next.onDismissQuestion &&
    prev.onCancelQueued === next.onCancelQueued &&
    prev.onOpenAgent === next.onOpenAgent,
);

/** Jump-to-bottom pill driven by the virtualizer's end state. */
function JumpToBottom({
  virtualizer,
}: {
  virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
}) {
  const { t } = useI18n();
  if (virtualizer.isAtEnd(TRANSCRIPT_END_THRESHOLD)) return null;
  return (
    <button
      type="button"
      onClick={() => { virtualizer.scrollToEnd({ behavior: 'smooth' }); }}
      className="anim-enter absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-panel/95 px-3 py-1.5 text-[11.5px] font-medium text-ink-soft shadow-[0_4px_16px_-6px_rgba(28,25,23,0.25)] transition-colors hover:border-accent hover:text-accent"
    >
      <span aria-hidden className="text-[10px]">▼</span> {t('transcript.jumpToLatest')}
    </button>
  );
}

/** Top edge loads history; end anchoring owns viewport preservation. */
function TopEdge({ state, onLoadOlder, scrollRef }: {
  state: SessionViewState;
  onLoadOlder: () => Promise<boolean>;
  scrollRef: { readonly current: HTMLDivElement | null };
}) {
  const { t } = useI18n();
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
      void onLoadOlder().finally(() => {
        inflightRef.current = false;
      });
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
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

/** The running clock appears only once the wait is visibly long. */
const TURN_CLOCK_AFTER_MS = 15_000;

/**
 * Turn-level running signal (deepseek-harness's TurnStatus, MIT): a
 * status line for the gaps where no token is streaming (first-token wait,
 * tool execution between steps), with a cumulative clock once the turn has
 * run ≥15s. The clock anchors ONLY to the live `turn.started` frame — when
 * no real start is known (e.g. a mid-turn reload whose snapshot carries no
 * running-turn timestamp) the line still names the wait but shows no clock
 * rather than timing from an arbitrary mount point.
 */
const TurnStatusLine = memo(function TurnStatusLine({
  startedAt,
  retry,
}: {
  startedAt: number | undefined;
  retry?: TurnRetryInfo;
}) {
  const { t, time } = useI18n();
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
  );
  useEffect(() => {
    if (startedAt === undefined) return;
    const tick = () => { setElapsedMs(Math.max(0, Date.now() - startedAt)); };
    tick();
    const timer = setInterval(tick, 1000);
    return () => { clearInterval(timer); };
  }, [startedAt]);
  // A provider retry names the wait: cause + attempt counter + backoff delay,
  // in warn tone, so a failing relay reads as such instead of a stuck tool.
  const retryText =
    retry === undefined
      ? undefined
      : t('transcript.turnRetrying', {
          cause: retry.statusCode !== undefined ? String(retry.statusCode) : (retry.errorName ?? '?'),
          attempt: String(retry.failedAttempt),
          max: String(retry.maxAttempts),
          delay: time.formatDuration(retry.delayMs),
        });
  return (
    <div
      role="status"
      aria-live="polite"
      data-turn-status
      className={`anim-enter flex items-center gap-2 pl-1 text-[11.5px] font-medium ${retryText === undefined ? 'text-ink-faint' : 'text-amber-ink'}`}
    >
      <span className={`status-dot-busy h-1.5 w-1.5 rounded-full ${retryText === undefined ? 'bg-accent' : 'bg-amber-ink'}`} />
      <span>{retryText ?? t('transcript.turnWorking')}</span>
      {startedAt !== undefined && elapsedMs >= TURN_CLOCK_AFTER_MS ? (
        <span aria-hidden className="font-mono text-[10.5px] tabular-nums text-ink-faint/80">
          {time.formatDuration(elapsedMs)}
        </span>
      ) : null}
    </div>
  );
});

/** Latency readout: one decimal under 10s, whole seconds beyond. */
function formatLatencySeconds(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
}

/**
 * External-executor badge opening a turn run by an off-kiki harness (design
 * §8: `executor.turn.metadata` → `TranscriptTurn.execution`). Shows
 * `Executor · Protocol`; degraded fidelity adds an amber marker listing the
 * stable loss codes, with per-code explanations in the tooltip.
 */
export const TurnExecutionBadge = memo(function TurnExecutionBadge({
  execution,
}: {
  execution: TurnExecutionInfo;
}) {
  const { t } = useI18n();
  const executor =
    execution.executorId.charAt(0).toUpperCase() + execution.executorId.slice(1);
  const protocol = execution.protocol === 'acp-v1' ? 'ACP' : execution.protocol;
  const degraded = execution.fidelity === 'degraded' || execution.losses.length > 0;
  const lossTooltip = execution.losses
    .map((code) => {
      const key = `transcript.loss.${code}` as I18nKey;
      const text = t(key);
      return text === key ? code : `${code} — ${text}`;
    })
    .join('\n');
  return (
    <div data-turn-execution className="anim-enter flex flex-wrap items-center gap-1.5">
      <span
        title={
          execution.resumeMode === undefined
            ? undefined
            : t('transcript.exec.resumeMode', { mode: execution.resumeMode })
        }
        className="inline-flex items-center gap-1 rounded-full border border-hairline bg-panel px-2 py-0.5 text-[10.5px] font-medium text-ink-faint"
      >
        <span aria-hidden className="text-[9px]">⬈</span>
        {t('transcript.exec.badge', { executor, protocol })}
      </span>
      {degraded ? (
        <span
          title={lossTooltip === '' ? undefined : lossTooltip}
          className="inline-flex items-center gap-1 rounded-full border border-amber-rule/40 bg-amber-card px-2 py-0.5 text-[10.5px] font-medium text-amber-ink"
        >
          <span aria-hidden className="text-[9px]">⚠</span>
          {t('transcript.exec.degraded')}
          {execution.losses.length > 0 ? (
            <span className="font-mono text-[9.5px] text-amber-ink/80">
              {execution.losses.join(' ')}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
});

/**
 * End-of-turn readout (deepseek-harness's turn tail, MIT): end clock ·
 * Ran for … · TTFT … · output decode throughput.
 */
export const TurnTailLine = memo(function TurnTailLine({ tail }: { tail: TurnTailInfo }) {
  const { t, time } = useI18n();
  const [copied, setCopied] = useState(false);
  const isFailed = tail.state === 'failed';
  const isCancelled = tail.state === 'cancelled';
  const facts: string[] = [];
  if (tail.durationMs !== undefined) {
    facts.push(t('transcript.ranFor', { duration: time.formatDuration(tail.durationMs) }));
  }
  if (tail.ttftMs !== undefined) {
    facts.push(t('transcript.ttft', { seconds: formatLatencySeconds(tail.ttftMs) }));
  }
  if (tail.tokensPerSecond !== undefined) {
    facts.push(
      t('transcript.tokensPerSecond', { rate: formatTokensPerSecond(tail.tokensPerSecond) }),
    );
  }

  const handleCopyError = useCallback(() => {
    if (tail.error === undefined) return;
    void copyTextToClipboard(tail.error).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    });
  }, [tail.error]);

  return (
    <div
      data-turn-tail
      data-turn-tail-state={tail.state}
      className={`anim-enter py-1 ${isFailed ? 'text-danger' : isCancelled ? 'text-amber-ink' : ''}`}
    >
      <div className="flex items-center gap-3">
        <span className={`h-px flex-1 ${isFailed ? 'bg-danger/30' : isCancelled ? 'bg-amber-rule/30' : 'bg-hairline'}`} />
        <div className="flex items-center gap-2">
          {isFailed ? (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold text-danger">
              {t('notice.turnFailed')}
            </span>
          ) : isCancelled ? (
            <span className="rounded-full bg-amber-card px-2 py-0.5 text-[10.5px] font-semibold text-amber-ink">
              {t('transcript.stopped')}
            </span>
          ) : null}
          <span className={`font-mono text-[10.5px] ${isFailed ? 'text-danger/80' : isCancelled ? 'text-amber-ink/80' : 'text-ink-faint'}`}>
            <RelativeTime at={tail.endedAt} />{facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}
          </span>
          {isFailed && tail.error !== undefined ? (
            <button
              type="button"
              onClick={handleCopyError}
              className="rounded border border-danger/30 px-1.5 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/10"
              title={tail.error}
            >
              {copied ? t('cb.copied') : t('cb.copy')}
            </button>
          ) : null}
        </div>
        <span className={`h-px flex-1 ${isFailed ? 'bg-danger/30' : isCancelled ? 'bg-amber-rule/30' : 'bg-hairline'}`} />
      </div>
      {isFailed && tail.error !== undefined ? (
        <div
          title={tail.error}
          className="mx-auto mt-1 max-w-[var(--kiki-chat-content-width,760px)] truncate rounded border border-danger/30 bg-danger/5 px-2.5 py-1 text-center font-mono text-[11px] text-danger"
        >
          {tail.error}
        </div>
      ) : null}
    </div>
  );
});

export function Transcript({
  state,
  agentId = 'main',
  onLoadOlder,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onCancelQueued,
  onRetryLoad,
  readOnly = false,
  forest,
  onOpenAgent,
  rowActions,
}: {
  state: SessionViewState;
  agentId?: string;
  onLoadOlder: () => Promise<boolean>;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
    selectedOptionId?: string,
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onDismissQuestion: (questionId: string) => Promise<void>;
  onCancelQueued?: (promptId: string) => void;
  onRetryLoad?: () => void;
  readOnly?: boolean;
  forest?: AgentForest;
  onOpenAgent?: (agentId: string) => void;
  rowActions?: TranscriptRowActions;
}) {
  const { t } = useI18n();
  const { blocks, loaded, loadError } = state;
  const timelineBlocks = useMemo(
    () => blocks.filter((block) => block.kind !== 'user' || block.promptStatus !== 'queued'),
    [blocks],
  );
  const annotationOverrides = useSyncExternalStore(
    subscribeAnnotationOverrides,
    getAnnotationOverridesSnapshot,
    getAnnotationOverridesSnapshot,
  );
  const derivedAnnotationTargets = useMemo(
    () => collectTimelineAnnotations(timelineBlocks),
    [timelineBlocks],
  );
  const resolvedAnnotationTargets = useMemo(
    () => applyAnnotationOverrides(derivedAnnotationTargets, annotationOverrides),
    [annotationOverrides, derivedAnnotationTargets],
  );
  const annotationTargets = useStableAnnotationTargets(resolvedAnnotationTargets);
  const annotationsById = useMemo(() => {
    const map = new Map<string, TimelineAnnotation>();
    for (const annotations of annotationTargets.values()) {
      for (const annotation of annotations) map.set(annotation.id, annotation);
    }
    return map;
  }, [annotationTargets]);
  const [annotationPopover, setAnnotationPopover] = useState<AnnotationPopoverOpen | null>(null);
  const openAnnotation =
    annotationPopover === null ? undefined : annotationsById.get(annotationPopover.annotationId);
  const closeAnnotationPopover = useCallback(() => { setAnnotationPopover(null); }, []);
  const openAnnotationMark = useCallback((mark: HTMLElement) => {
    const annotationId = mark.dataset['annotationRef'];
    if (annotationId === undefined) return;
    const rect = mark.getBoundingClientRect();
    setAnnotationPopover({
      annotationId,
      anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    });
  }, []);
  const handleAnnotationClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    const mark = event.target.closest<HTMLElement>('[data-annotation-ref]');
    if (mark === null || !event.currentTarget.contains(mark)) return;
    event.preventDefault();
    event.stopPropagation();
    openAnnotationMark(mark);
  }, [openAnnotationMark]);
  const handleAnnotationKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-annotation-ref]')) return;
    event.preventDefault();
    event.stopPropagation();
    openAnnotationMark(event.target);
  }, [openAnnotationMark]);
  const handleAnnotationScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    if (annotationPopover === null) return;
    const transcript = event.currentTarget;
    setAnnotationPopover((current) => {
      if (current === null) return null;
      const mark = [...transcript.querySelectorAll<HTMLElement>('[data-annotation-ref]')].find(
        (candidate) => candidate.dataset['annotationRef'] === current.annotationId,
      );
      if (mark === undefined) return null;
      const rect = mark.getBoundingClientRect();
      const anchor = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      return current.anchor.left === anchor.left &&
        current.anchor.top === anchor.top &&
        current.anchor.right === anchor.right &&
        current.anchor.bottom === anchor.bottom
        ? current
        : { ...current, anchor };
    });
  }, [annotationPopover]);
  const updateAnnotationOverride = useCallback((id: string, patch: AnnotationOverride) => {
    const previous = getAnnotationOverridesSnapshot()[id] ?? {};
    writeAnnotationOverride(id, { ...previous, ...patch });
  }, []);
  useEffect(() => {
    if (annotationPopover !== null && openAnnotation === undefined) setAnnotationPopover(null);
  }, [annotationPopover, openAnnotation]);
  // The fold-steps preference is app-global chrome (Settings' Timeline card
  // writes it), so the transcript reacts immediately via its pub/sub snapshot.
  const foldSteps = useSyncExternalStore(
    subscribeSettings,
    settingsSnapshot,
    settingsServerSnapshot,
  ).foldSteps;
  // The fold preference is part of the grouping input: off renders the raw
  // step blocks (no groups at all), on folds runs of ≥2, and toggling it
  // re-groups on the next render — the switch applies instantly.
  const nodes = useMemo(
    () => (foldSteps ? groupBlocks(timelineBlocks) : timelineBlocks),
    [foldSteps, timelineBlocks],
  );
  // The forest prop is rebuilt per publish upstream; stabilize it by content
  // so row memos survive unrelated deltas (Finding: forest identity).
  const stableForest = useStableForest(forest);
  // Manual subagent card form overrides (G-4): once the user expands or
  // collapses a card by hand the automatic active→full / terminal→compact
  // rule no longer touches that agent's card. Keyed by subagentId so the
  // choice survives block identity churn across publishes.
  const [cardForms, setCardForms] = useState<ReadonlyMap<string, SubagentCardForm>>(new Map());
  const handleToggleSubagentForm = useCallback((agentId: string, form: SubagentCardForm) => {
    setCardForms((previous) => {
      const next = new Map(previous);
      next.set(agentId, form);
      return next;
    });
  }, []);
  const visibleTailTurnId = state.busy ? undefined : state.turnTail?.turnId;
  // Fold historical terminal entries into one expandable summary row. Failures
  // keep a danger summary; terminal notices for the visible latest tail remain
  // standalone so the current outcome is never hidden.
  const groupedNodes = useMemo(
    () => groupHistoryRuns(
      nodes,
      (node) => isCompactHistoryNode(node, stableForest, cardForms, visibleTailTurnId),
    ),
    [nodes, stableForest, cardForms, visibleTailTurnId],
  );
  const childBlocks = useStableMap(() => {
    const map = new Map<string, SubagentBlock>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block);
    }
    return map;
  });
  const agentNames = useStableMap(() => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      if (block.kind === 'subagent') map.set(block.subagentId, block.name);
    }
    if (stableForest !== undefined) {
      for (const node of Object.values(stableForest.byId)) {
        if (!map.has(node.agentId)) map.set(node.agentId, node.label);
      }
    }
    return map;
  });
  // y/n acts on the focused card, else the topmost visible pending card
  // (SessionView's resolver); every pending card advertises that shortcut.
  const hasUnresolvedApproval = useMemo(
    () => blocks.some((b) => b.kind === 'approval' && b.resolution === undefined),
    [blocks],
  );
  // The turn-level status line fills the no-token gaps (first-token wait,
  // tool execution); while text streams the stream-caret is the signal.
  const streamingNow = blocks.some(
    (b) => (b.kind === 'assistant' || b.kind === 'thinking') && b.streaming,
  );
  const showTurnStatus = state.busy && !streamingNow;
  // Regenerate/fork anchor: the latest completed turn's final assistant reply.
  // Changes only at turn boundaries, so the page memos survive token deltas.
  const latestFinalAssistantId = useMemo(() => latestFinalAssistantBlockId(blocks), [blocks]);
  // External-executor badges: first display node of each turn that carries
  // `execution` provenance. Entry identity is stabilized upstream (the
  // projection reuses unchanged TurnExecutionInfo objects), so the map — and
  // thus every row prop — survives unrelated deltas.
  const executionBadges = useStableMap(() => {
    const map = new Map<string, TurnExecutionInfo>();
    const seenTurns = new Set<string>();
    for (const node of groupedNodes) {
      const turnId = displayNodeTurnId(node);
      if (turnId === undefined || seenTurns.has(turnId)) continue;
      seenTurns.add(turnId);
      const execution = state.turnExecutions[turnId];
      if (execution !== undefined) map.set(groupedNodeKey(node), execution);
    }
    return map;
  });
  const virtualNodes = useMemo<readonly TranscriptVirtualNode[]>(
    () => groupedNodes.length === 0 ? [undefined] : groupedNodes,
    [groupedNodes],
  );
  const nodeIndexes = useMemo(() => {
    const map = new Map<string, number>();
    virtualNodes.forEach((node, index) => { map.set(virtualNodeKey(node), index); });
    return map;
  }, [virtualNodes]);
  const nodeIndexesRef = useRef(nodeIndexes);
  nodeIndexesRef.current = nodeIndexes;
  const [editingBlockIds, setEditingBlockIds] = useState<readonly string[]>([]);
  const pinnedIndexes = useMemo(() => {
    const indexes = new Set<number>();
    virtualNodes.forEach((node, index) => {
      if (
        (node?.kind === 'approval' && node.resolution === undefined) ||
        (node?.kind === 'question' && node.outcome === undefined)
      ) {
        indexes.add(index);
      }
    });
    for (const blockId of editingBlockIds) {
      const index = nodeIndexes.get(blockId);
      if (index !== undefined) indexes.add(index);
    }
    return [...indexes].sort((left, right) => left - right);
  }, [editingBlockIds, nodeIndexes, virtualNodes]);
  const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
    if (pinnedIndexes.length === 0) return defaultRangeExtractor(range);
    const indexes = new Set(defaultRangeExtractor(range));
    for (const index of pinnedIndexes) indexes.add(index);
    return [...indexes].sort((left, right) => left - right);
  }, [pinnedIndexes]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportAnchorRef = useRef<TranscriptViewportAnchor>({
    atEnd: true,
    key: undefined,
    offset: 0,
  });
  const initialScrollDoneRef = useRef(false);
  const initialScrollFrameRef = useRef<number | null>(null);
  const measuredResetRef = useRef(state.transcriptResetVersion);
  const pendingResetRestoreRef = useRef<PendingResetRestore | null>(null);
  // Restore end anchoring when the estimate→actual delta breaks it. During a
  // streaming turn a row grows from TRANSCRIPT_ESTIMATED_ROW_HEIGHT (120px)
  // to its real height (a streamed answer reaches 500px+); the fork's
  // #1218-style re-measure rule skips the scrollTop compensation for a row
  // that spans the fold, and its `wasAtEnd` gate reads the VIRTUAL distance —
  // already polluted by the stale estimate — so the end anchor is lost the
  // first time the viewport rests below a growing block. Re-assert "truly at
  // end" from the ACTUAL DOM distance (scrollHeight − clientHeight −
  // scrollTop): when the viewport is still anchored (the real distance after
  // the growth stays within the follow threshold), the compensation runs and
  // follow survives. Returning true only there leaves the fork's default
  // backward-scroll and above-fold rules untouched.
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: virtualNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TRANSCRIPT_ESTIMATED_ROW_HEIGHT,
    measureElement: measureTranscriptRow,
    getItemKey: (index) => virtualNodeKey(virtualNodes[index]),
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: TRANSCRIPT_END_THRESHOLD,
    overscan: TRANSCRIPT_OVERSCAN,
    rangeExtractor,
    paddingStart: 24,
    paddingEnd: 60,
    gap: 16,
    initialRect: { width: 760, height: 600 },
    useAnimationFrameWithResizeObserver: false,
    useFlushSync: false,
    directDomUpdates: true,
    directDomUpdatesMode: 'position',
    onChange: (instance) => {
      viewportAnchorRef.current = captureTranscriptAnchor(instance);
    },
  });
  // The instance field (not an option) — assign once, after mount.
  virtualizerRef.current = virtualizer;
  useEffect(() => {
    const instance = virtualizerRef.current;
    if (instance === null) return;
    instance.shouldAdjustScrollPositionOnItemSizeChange = (_item, delta) => {
      if (delta <= 0) return false;
      const el = instance.scrollElement;
      if (!(el instanceof HTMLElement)) return false;
      const realDistanceFromEnd = el.scrollHeight - el.clientHeight - el.scrollTop;
      return realDistanceFromEnd - delta <= TRANSCRIPT_END_THRESHOLD;
    };
  }, [virtualizer]);

  useLayoutEffect(() => {
    if (!loaded || loadError !== undefined) return;
    const scroll = scrollRef.current;
    if (scroll === null) return;
    const updateEditingRows = () => {
      const blockIds = [...scroll.querySelectorAll<HTMLElement>('[data-edit-editor]')]
        .map((editor) => editor.closest<HTMLElement>('[data-block-id]')?.dataset['blockId'])
        .filter((blockId): blockId is string => blockId !== undefined)
        .sort();
      setEditingBlockIds((previous) =>
        previous.length === blockIds.length && previous.every((blockId, index) => blockId === blockIds[index])
          ? previous
          : blockIds,
      );
    };
    updateEditingRows();
    const observer = new MutationObserver(updateEditingRows);
    observer.observe(scroll, { childList: true, subtree: true });
    return () => { observer.disconnect(); };
  }, [loadError, loaded, virtualNodes.length]);

  useLayoutEffect(() => {
    if (!loaded || loadError !== undefined || scrollRef.current === null) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      measuredResetRef.current = state.transcriptResetVersion;
      virtualizer.scrollToEnd();
      initialScrollFrameRef.current = requestAnimationFrame(() => {
        initialScrollFrameRef.current = null;
        virtualizer.scrollToEnd();
        viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
      });
      viewportAnchorRef.current = { atEnd: true, key: undefined, offset: 0 };
      return;
    }
    if (measuredResetRef.current !== state.transcriptResetVersion) {
      measuredResetRef.current = state.transcriptResetVersion;
      const previousPending = pendingResetRestoreRef.current;
      if (previousPending?.frame !== null && previousPending?.frame !== undefined) {
        cancelAnimationFrame(previousPending.frame);
      }
      const anchor = previousPending?.anchor ?? viewportAnchorRef.current;
      virtualizer.measure();
      for (const element of virtualizer.elementsCache.values()) {
        virtualizer.measureElement(element);
      }
      pendingResetRestoreRef.current = {
        version: state.transcriptResetVersion,
        anchor,
        frame: null,
      };
    }
    const pending = pendingResetRestoreRef.current;
    if (pending === null || pending.frame !== null) return;
    pending.frame = requestAnimationFrame(() => {
      if (pendingResetRestoreRef.current !== pending) return;
      const { anchor } = pending;
      if (anchor.atEnd) {
        virtualizer.scrollToEnd();
        pendingResetRestoreRef.current = null;
        return;
      }
      const index = anchor.key === undefined ? undefined : nodeIndexesRef.current.get(anchor.key);
      if (index === undefined) {
        virtualizer.scrollToEnd();
        pendingResetRestoreRef.current = null;
        return;
      }
      const offset = virtualizer.getOffsetForIndex(index, 'start')?.[0];
      if (offset !== undefined) {
        virtualizer.scrollToOffset(offset + anchor.offset, { align: 'start' });
      }
      pendingResetRestoreRef.current = null;
    });
  }, [loadError, loaded, state.transcriptResetVersion, virtualNodes.length, virtualizer]);

  useEffect(() => () => {
    const initialFrame = initialScrollFrameRef.current;
    if (initialFrame !== null) cancelAnimationFrame(initialFrame);
    const resetFrame = pendingResetRestoreRef.current?.frame;
    if (resetFrame !== null && resetFrame !== undefined) cancelAnimationFrame(resetFrame);
  }, []);

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

  if (timelineBlocks.length === 0 && !state.busy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 opacity-70">
        <Wordmark size="lg" />
        <p className="text-[13px] text-ink-faint">{t('transcript.blank')}</p>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-transcript-scroll
        role="log"
        className="absolute inset-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none]"
        onClick={handleAnnotationClick}
        onKeyDown={handleAnnotationKeyDown}
        onScroll={handleAnnotationScroll}
      >
        {/* Bottom clearance is 24px of breathing room + the 36px fade band the
            shell's active composer seat overlaps (see index.css). */}
        <div
          ref={virtualizer.containerRef}
          data-transcript-virtual-content
          className="relative w-full"
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const node = virtualNodes[virtualItem.index];
            const first = virtualItem.index === 0;
            const last = virtualItem.index === virtualNodes.length - 1;
            return (
              <div
                key={virtualItem.key}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                data-transcript-virtual-item
                className="absolute left-0 w-full"
              >
                <div className="mx-auto flex max-w-[var(--kiki-chat-content-width,760px)] flex-col gap-4 px-6">
                  {first ? <TopEdge state={state} onLoadOlder={onLoadOlder} scrollRef={scrollRef} /> : null}
                  {node === undefined ? null : (
                    <TranscriptRow
                      node={node}
                      agentId={agentId}
                      readOnly={readOnly}
                      approvalShortcutHints={hasUnresolvedApproval}
                      agentNames={agentNames}
                      childBlocks={childBlocks}
                      forest={stableForest}
                      rowActions={rowActions}
                      latestFinalAssistantId={latestFinalAssistantId}
                      annotations={annotationTargets.get(virtualNodeKey(node))}
                      executionBadge={executionBadges.get(virtualNodeKey(node))}
                      subagentFormOverrides={cardForms}
                      onToggleSubagentForm={handleToggleSubagentForm}
                      onResolveApproval={onResolveApproval}
                      onAnswerQuestion={onAnswerQuestion}
                      onDismissQuestion={onDismissQuestion}
                      onCancelQueued={onCancelQueued}
                      onOpenAgent={onOpenAgent}
                    />
                  )}
                  {last && showTurnStatus ? (
                    <TurnStatusLine startedAt={state.turnStartedAt} retry={state.turnRetry} />
                  ) : null}
                  {last && !state.busy && state.turnTail !== undefined ? (
                    <TurnTailLine tail={state.turnTail} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {annotationPopover !== null && openAnnotation !== undefined ? (
        <AnnotationPopover
          state={annotationPopover}
          annotation={openAnnotation}
          onSave={(id, comment) => { updateAnnotationOverride(id, { comment }); }}
          onRemove={(id) => {
            updateAnnotationOverride(id, { deleted: true });
            closeAnnotationPopover();
          }}
          onClose={closeAnnotationPopover}
        />
      ) : null}
      <FloorNavRail
        blocks={timelineBlocks}
        nodeIndexes={nodeIndexes}
        scrollRef={scrollRef}
        virtualizer={virtualizer}
      />
      <JumpToBottom virtualizer={virtualizer} />
    </div>
  );
}
