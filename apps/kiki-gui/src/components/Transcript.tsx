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

import { useEffect, useMemo, useRef, useState } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

import type { ApprovalDecision, QuestionAnswer } from '@moonshot-ai/protocol';

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
  SubagentBlock,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from '../state/transcript';
import { ApprovalCard, QuestionCard } from './Interactions';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { KikiMark, Wordmark } from './Wordmark';

function absoluteTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}

function UserMessage({ block }: { block: UserBlock }) {
  return (
    <div className="anim-enter flex flex-col items-end" title={absoluteTime(block.createdAt)}>
      <span className="mb-1 pr-1 text-[10.5px] font-semibold tracking-wide text-ink-faint uppercase">
        You
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-hairline bg-[#f3ede1] px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {block.text}
      </div>
    </div>
  );
}

function AssistantMessage({ block }: { block: AssistantBlock }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="anim-enter group/msg relative flex gap-3" title={absoluteTime(block.createdAt)}>
      <KikiMark className="mt-[7px] shrink-0" />
      <div className="min-w-0 flex-1">
        <Markdown text={block.text} />
        {block.streaming ? <span className="stream-caret font-mono">▍</span> : null}
      </div>
      {!block.streaming && block.text !== '' ? (
        <button
          type="button"
          title="Copy markdown"
          onClick={() => {
            void navigator.clipboard
              .writeText(block.text)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              })
              .catch(() => undefined);
          }}
          className={`absolute -top-1 right-0 rounded-md border border-hairline bg-panel px-1.5 py-0.5 font-mono text-[10px] transition-opacity ${
            copied ? 'text-success opacity-100' : 'text-ink-faint opacity-0 group-hover/msg:opacity-100 hover:text-ink'
          }`}
        >
          {copied ? '✓' : 'copy'}
        </button>
      ) : null}
    </div>
  );
}

function ThinkingMessage({ block }: { block: ThinkingBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-enter border-l-2 border-hairline-strong pl-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-faint transition-colors hover:text-ink-soft"
      >
        <span aria-hidden className={`inline-block transition-transform duration-150 ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
        Thinking{block.streaming ? '…' : ''}
        {block.streaming ? <span className="stream-caret">▍</span> : null}
      </button>
      {open ? (
        <div className="mt-1.5 text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-soft italic">
          {block.text}
        </div>
      ) : null}
    </div>
  );
}

function ShellMessage({ block }: { block: ShellBlock }) {
  return (
    <div className="anim-enter overflow-hidden rounded-lg bg-ink">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="font-mono text-[11px] font-semibold text-accent">shell</span>
        {!block.done ? <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" /> : null}
        {block.done && block.isError === true ? (
          <span className="font-mono text-[10.5px] text-danger">failed</span>
        ) : null}
      </div>
      <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-[#e8dcc4]">
        {block.output === '' ? '…' : block.output}
      </pre>
    </div>
  );
}

function SubagentCard({ block }: { block: SubagentBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="anim-enter ml-6 rounded-xl border border-hairline bg-panel/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span aria-hidden className="font-mono text-[11px] text-ink-soft">⧉</span>
        <span className="text-[12px] font-semibold text-ink">{block.name}</span>
        <span
          className={`rounded-full px-1.5 py-px text-[10px] font-medium ${
            block.status === 'running'
              ? 'bg-accent-soft text-accent'
              : block.status === 'completed'
                ? 'bg-success/10 text-success'
                : block.status === 'failed'
                  ? 'bg-danger/10 text-danger'
                  : 'bg-paper text-ink-soft'
          }`}
        >
          {block.status}
        </span>
        {block.description !== undefined ? (
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-faint">
            {block.description}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span aria-hidden className={`text-[9px] text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {open && (block.summary !== undefined || block.error !== undefined) ? (
        <div className="border-t border-hairline px-3 py-2 text-[12px] text-ink-soft">
          {block.error !== undefined ? (
            <span className="text-danger">{block.error}</span>
          ) : (
            <Markdown text={block.summary ?? ''} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function Notice({ block }: { block: NoticeBlock }) {
  if (block.tone === 'danger') {
    return (
      <div className="anim-enter rounded-lg border border-danger/30 bg-danger/5 px-3 py-1.5 text-[12px] text-danger">
        {block.text}
      </div>
    );
  }
  return (
    <div className="anim-enter flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[11px] text-ink-faint">{block.text}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

/**
 * Folded tool run — aionui's group summary row, kiki rules: collapsed by
 * default, spinner while any tool runs, auto-expands on error only.
 */
function ToolGroupRow({ group }: { group: ToolGroup }) {
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
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-paper/60"
      >
        <span className="w-6 shrink-0 text-center font-mono text-[12px] text-ink-soft">☰</span>
        <span className="shrink-0 text-[12.5px] font-semibold text-ink">
          Steps · {group.tools.length}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
          {groupToolNames(group)}
        </span>
        {running ? (
          <svg className="spinner h-3.5 w-3.5 text-accent" viewBox="0 0 16 16" fill="none" aria-label="running">
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
            <ToolCard key={tool.id} block={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BlockView({
  block,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  block: Exclude<Block, ToolBlock>;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => void;
  onDismissQuestion: (questionId: string) => void;
}) {
  switch (block.kind) {
    case 'user':
      return <UserMessage block={block} />;
    case 'assistant':
      return <AssistantMessage block={block} />;
    case 'thinking':
      return <ThinkingMessage block={block} />;
    case 'shell':
      return <ShellMessage block={block} />;
    case 'subagent':
      return <SubagentCard block={block} />;
    case 'notice':
      return <Notice block={block} />;
    case 'approval':
      return (
        <ApprovalCard
          block={block}
          onResolve={(decision, scope) => onResolveApproval(block.request.approval_id, decision, scope)}
        />
      );
    case 'question':
      return (
        <QuestionCard
          block={block}
          onAnswer={(answers) => onAnswerQuestion(block.request.question_id, answers)}
          onDismiss={() => onDismissQuestion(block.request.question_id)}
        />
      );
  }
}

function nodeKey(node: DisplayNode): string {
  return node.kind === 'tool-group' ? node.id : node.id;
}

/**
 * Jump-to-bottom pill — shown only when the user has scrolled up (codeg's
 * conditional centered pill driven by useStickToBottomContext).
 */
function JumpToBottom() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      onClick={() => scrollToBottom()}
      className="anim-enter absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-panel/95 px-3 py-1.5 text-[11.5px] font-medium text-ink-soft shadow-[0_4px_16px_-6px_rgba(28,25,23,0.25)] transition-colors hover:border-accent hover:text-accent"
    >
      <span aria-hidden className="text-[10px]">▼</span> Jump to latest
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
  const { scrollRef } = useStickToBottomContext();
  const inflightRef = useRef(false);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onScroll = () => {
      if (
        inflightRef.current ||
        state.loadingOlder ||
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
    return () => element.removeEventListener('scroll', onScroll);
  }, [scrollRef, state.loadingOlder, state.hasMoreHistory, onLoadOlder]);

  if (state.loadingOlder) {
    return (
      <div className="flex items-center justify-center gap-2 pb-2 text-[11.5px] text-ink-faint">
        <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
        Loading earlier messages…
      </div>
    );
  }
  if (!state.hasMoreHistory && state.fetchedOlder) {
    return (
      <div className="flex items-center gap-3 pb-1">
        <span className="h-px flex-1 bg-hairline" />
        <span className="text-[10.5px] text-ink-faint">beginning of history</span>
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
}: {
  state: SessionViewState;
  onLoadOlder: () => Promise<boolean>;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => void;
  onDismissQuestion: (questionId: string) => void;
}) {
  const { blocks, loaded } = state;
  const nodes = useMemo(() => groupBlocks(blocks), [blocks]);

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-ink-faint">
        Opening session…
      </div>
    );
  }

  if (blocks.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 opacity-70">
        <Wordmark size="lg" />
        <p className="text-[13px] text-ink-faint">A blank page. Tell kiki what to make.</p>
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
      <StickToBottom.Content className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-6">
        <TopEdge state={state} onLoadOlder={onLoadOlder} />
        {nodes.map((node) => (
          <div key={nodeKey(node)} data-block-id={nodeKey(node)}>
            {node.kind === 'tool-group' ? (
              <ToolGroupRow group={node} />
            ) : node.kind === 'tool' ? (
              <ToolCard block={node} />
            ) : (
              <BlockView
                block={node}
                onResolveApproval={onResolveApproval}
                onAnswerQuestion={onAnswerQuestion}
                onDismissQuestion={onDismissQuestion}
              />
            )}
          </div>
        ))}
      </StickToBottom.Content>
      <JumpToBottom />
    </StickToBottom>
  );
}
