/**
 * Transcript — journal-style rendering of the session blocks: generous
 * whitespace, no assistant bubble (kiki mark + content), ink user cards,
 * collapsible thinking, tool cards, dark shell islands, amber interactions.
 */

import { useState } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';

import type { ApprovalDecision, QuestionAnswer } from '@moonshot-ai/protocol';

import type {
  AssistantBlock,
  Block,
  NoticeBlock,
  ShellBlock,
  SubagentBlock,
  ThinkingBlock,
  UserBlock,
} from '../state/transcript';
import { ApprovalCard, QuestionCard } from './Interactions';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import { KikiMark, Wordmark } from './Wordmark';

function UserMessage({ block }: { block: UserBlock }) {
  return (
    <div className="anim-enter flex flex-col items-end">
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
  return (
    <div className="anim-enter flex gap-3">
      <KikiMark className="mt-[7px] shrink-0" />
      <div className="min-w-0 flex-1">
        <Markdown text={block.text} />
        {block.streaming ? <span className="stream-caret font-mono">▍</span> : null}
      </div>
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

function BlockView({
  block,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  block: Block;
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
    case 'tool':
      return <ToolCard block={block} />;
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

/**
 * Jump-to-bottom pill — shown only when the user has scrolled up. Pattern
 * ported from codeg (https://github.com/codeg-vn/codeg —
 * `src/components/ai-elements/message-thread.tsx`, Apache-2.0): StickToBottom
 * with `initial="instant" resize="smooth"` plus a conditional centered pill
 * driven by `useStickToBottomContext`.
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

export function Transcript({
  blocks,
  loaded,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
}: {
  blocks: readonly Block[];
  loaded: boolean;
  onResolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    scope?: 'session',
  ) => Promise<void>;
  onAnswerQuestion: (questionId: string, answers: Record<string, QuestionAnswer>) => void;
  onDismissQuestion: (questionId: string) => void;
}) {
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
        {blocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            onResolveApproval={onResolveApproval}
            onAnswerQuestion={onAnswerQuestion}
            onDismissQuestion={onDismissQuestion}
          />
        ))}
      </StickToBottom.Content>
      <JumpToBottom />
    </StickToBottom>
  );
}
