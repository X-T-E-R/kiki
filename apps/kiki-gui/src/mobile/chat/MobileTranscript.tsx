import { useEffect, useMemo, useRef, useState } from 'react';

import type { ApprovalDecision } from '@kiki/protocol';
import type { ActivitySummary, ApprovalBlock, Block, MessageBlock, ToolBlock } from '@kiki/session-core/session';

import { Icon } from '../../components/icons';
import { buildMessageNodes } from '../../components/message/messageTimeline';
import { useI18n } from '../../i18n';
import { isInlineDecidable, summarizeApproval } from '../approvalSummary';
import { ApprovalHeadline, RejectReasonSheet } from '../components/ApprovalParts';
import { Markdown } from '../../components/Markdown';
import { extractFileChanges, type HoodTab } from './LiftTheHoodSheet';
import { MobileQuestionCard, type QuestionAnswers } from './MobileQuestionCard';

interface MobileTranscriptProps {
  readonly blocks: readonly Block[];
  readonly loaded: boolean;
  readonly loadError?: string;
  readonly busy: boolean;
  readonly hasMoreHistory: boolean;
  readonly loadingOlder: boolean;
  /** Persona sessions that deliver through `send_message`: only sent messages read as replies. */
  readonly messageMode: boolean;
  readonly personaName?: string;
  /** A local persona greeting shown before the first turn; never part of model history. */
  readonly greeting?: MessageBlock;
  readonly onLoadOlder: () => void;
  readonly onRetryLoad?: () => void;
  readonly onOpenHood: (tab: HoodTab, changeId?: string) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalDecision, reason?: string) => void;
  readonly onAnswerQuestion: (questionId: string, answers: QuestionAnswers) => Promise<void>;
  readonly onDismissQuestion: (questionId: string) => Promise<void>;
  readonly onOpenWorkbench: () => void;
}

type RenderEntry =
  | { readonly kind: 'block'; readonly block: Block }
  | { readonly kind: 'steps'; readonly id: string; readonly count: number; readonly running?: ToolBlock; readonly single?: ToolBlock };

function groupReplyBlocks(blocks: readonly Block[]): readonly RenderEntry[] {
  const entries: RenderEntry[] = [];
  let pendingTools: ToolBlock[] = [];
  let pendingThinking = 0;

  const flushGroup = () => {
    if (pendingTools.length === 0 && pendingThinking === 0) return;
    const firstId = pendingTools[0]?.id ?? `think-${entries.length}`;
    entries.push({
      kind: 'steps',
      id: `grp-${firstId}`,
      count: pendingTools.length + pendingThinking,
      running: pendingTools.find((tool) => tool.status === 'running'),
      single: pendingTools.length === 1 && pendingThinking === 0 ? pendingTools[0] : undefined,
    });
    pendingTools = [];
    pendingThinking = 0;
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      pendingTools.push(block);
      continue;
    }
    if (block.kind === 'thinking') {
      pendingThinking += 1;
      continue;
    }
    if (block.kind === 'system-reminder' || block.kind === 'skill') {
      continue;
    }
    flushGroup();
    entries.push({ kind: 'block', block });
  }
  flushGroup();
  return entries;
}

function messageModeEntries(blocks: readonly Block[], busy: boolean, personaName: string | undefined): readonly RenderEntry[] {
  const entries: RenderEntry[] = [];
  for (const node of buildMessageNodes(blocks, { busy, personaName })) {
    if (node.kind === 'activity-summary') {
      const summary = node as ActivitySummary;
      const tools = summary.members.filter((member): member is ToolBlock => member.kind === 'tool');
      entries.push({
        kind: 'steps',
        id: `act-${summary.id}`,
        count: Math.max(1, summary.members.length),
        running: busy ? tools.find((tool) => tool.status === 'running') : undefined,
        single: tools.length === 1 && summary.members.length === 1 ? tools[0] : undefined,
      });
      continue;
    }
    entries.push({ kind: 'block', block: node as Block });
  }
  return entries;
}

function toolLabel(tool: ToolBlock): string {
  return tool.description ? `${tool.name} · ${tool.description}` : tool.name;
}

function InlineApprovalCard({
  block,
  onResolve,
  onOpenWorkbench,
}: {
  readonly block: ApprovalBlock;
  readonly onResolve: (approvalId: string, decision: ApprovalDecision, reason?: string) => void;
  readonly onOpenWorkbench: () => void;
}) {
  const { t } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const approvalId = block.request.approval_id;
  const summary = summarizeApproval(block.request);
  return (
    <div data-mobile-inline-approval={approvalId} className="rounded-2xl border border-hairline bg-panel p-3.5 shadow-xs">
      <ApprovalHeadline summary={summary} />
      <div className="mt-3 flex items-center gap-2">
        {isInlineDecidable(block.request) ? (
          <>
            <button
              type="button"
              data-mobile-approve-btn={approvalId}
              onClick={() => { onResolve(approvalId, 'approved'); }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep"
            >
              <Icon name="check" size={14} />
              <span>{t('mobile.approval.approve')}</span>
            </button>
            <button
              type="button"
              data-mobile-reject-btn={approvalId}
              onClick={() => { setRejecting(true); }}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-hairline bg-paper px-4 text-[14px] font-medium text-ink-soft transition-colors hover:text-ink"
            >
              <Icon name="cross" size={14} />
              <span>{t('mobile.approval.reject')}</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onOpenWorkbench}
            className="inline-flex h-11 items-center gap-1 rounded-full border border-hairline bg-paper px-4 text-[14px] font-medium text-ink-soft transition-colors hover:text-ink"
          >
            <span>{t('mobile.approval.details')}</span>
            <Icon name="chevron" size={12} />
          </button>
        )}
      </div>
      {rejecting ? (
        <RejectReasonSheet
          overlayId={`mobile-inline-reject-${approvalId}`}
          headline={summary.snippet ?? summary.headline}
          submitting={false}
          onCancel={() => { setRejecting(false); }}
          onSubmit={(reason) => {
            setRejecting(false);
            onResolve(approvalId, 'rejected', reason);
          }}
        />
      ) : null}
    </div>
  );
}

function AssistantBubble({ text }: { readonly text: string }) {
  return (
    <div data-mobile-msg="assistant" className="w-full text-[15.5px] leading-[1.6] text-ink">
      <Markdown text={text} />
    </div>
  );
}

export function MobileTranscript({
  blocks,
  loaded,
  loadError,
  busy,
  hasMoreHistory,
  loadingOlder,
  messageMode,
  personaName,
  greeting,
  onLoadOlder,
  onRetryLoad,
  onOpenHood,
  onResolveApproval,
  onAnswerQuestion,
  onDismissQuestion,
  onOpenWorkbench,
}: MobileTranscriptProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottomRef = useRef(true);

  const entries = useMemo(
    () => (messageMode ? messageModeEntries(blocks, busy, personaName) : groupReplyBlocks(blocks)),
    [blocks, busy, messageMode, personaName],
  );
  const fileChanges = useMemo(() => extractFileChanges(blocks), [blocks]);
  const hasUserTurn = useMemo(() => blocks.some((block) => block.kind === 'user'), [blocks]);
  const showGreeting = loaded && greeting !== undefined && !hasUserTurn && !hasMoreHistory;

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !pinnedBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, blocks]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    // The soft keyboard shrinks the list from below; keep the latest turn in view.
    const observer = new ResizeObserver(() => {
      if (pinnedBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
  }, []);

  const renderBlock = (block: Block) => {
    if (block.kind === 'user') {
      return (
        <div key={block.id} data-mobile-msg="user" className="flex justify-end">
          <div className="max-w-[84%] rounded-[20px] rounded-br-[6px] bg-bubble-user px-4 py-2.5 text-[15px] leading-[1.55] text-ink whitespace-pre-wrap break-words">
            {block.text}
          </div>
        </div>
      );
    }
    if (block.kind === 'assistant') {
      return <AssistantBubble key={block.id} text={block.text} />;
    }
    if (block.kind === 'message') {
      if (block.text.trim() === '' || block.handoff !== undefined) return null;
      return <AssistantBubble key={block.id} text={block.text} />;
    }
    if (block.kind === 'approval' && block.resolution === undefined) {
      return (
        <InlineApprovalCard
          key={block.id}
          block={block}
          onResolve={onResolveApproval}
          onOpenWorkbench={onOpenWorkbench}
        />
      );
    }
    if (block.kind === 'question') {
      return (
        <MobileQuestionCard
          key={block.id}
          block={block}
          onAnswer={onAnswerQuestion}
          onDismiss={onDismissQuestion}
          onOpenWorkbench={onOpenWorkbench}
        />
      );
    }
    return null;
  };

  return (
    <div
      ref={scrollRef}
      data-mobile-transcript
      data-mobile-transcript-mode={messageMode ? 'message' : 'reply'}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3"
    >
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        {hasMoreHistory ? (
          <div className="flex justify-center pb-1">
            <button
              type="button"
              data-mobile-load-older=""
              disabled={loadingOlder}
              onClick={onLoadOlder}
              className="h-11 rounded-full border border-hairline bg-panel px-4 text-[13px] font-medium text-ink-soft transition-colors hover:border-hairline-strong disabled:opacity-55"
            >
              {loadingOlder ? t('mobile.chat.loading') : t('mobile.chat.loadOlder')}
            </button>
          </div>
        ) : null}

        {showGreeting ? (
          <div data-mobile-msg="greeting" className="w-full text-[15.5px] leading-[1.6] text-ink">
            <Markdown text={greeting.text} />
          </div>
        ) : null}

        {loadError !== undefined && (!loaded || entries.length === 0) ? (
          <div
            role="alert"
            data-mobile-load-error=""
            className="mx-auto my-8 flex w-full max-w-[360px] flex-col items-center rounded-2xl border border-danger/30 bg-danger/5 px-4 py-5 text-center"
          >
            <p className="text-[14px] font-medium text-danger">{t('transcript.couldNotOpen')}</p>
            <p className="mt-1.5 break-words font-mono text-[12px] text-danger/80">{loadError}</p>
            {onRetryLoad !== undefined ? (
              <button
                type="button"
                data-mobile-retry-load=""
                onClick={onRetryLoad}
                className="mt-3.5 inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 text-[13.5px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep"
              >
                {t('common.retry')}
              </button>
            ) : null}
          </div>
        ) : !loaded ? (
          <p className="py-12 text-center text-[13.5px] text-ink-faint">{t('mobile.chat.loading')}</p>
        ) : entries.length === 0 && !showGreeting ? (
          <div className="py-16 text-center">
            <p className="font-display text-[20px] text-ink-soft">{t('mobile.chat.emptyHint')}</p>
          </div>
        ) : (
          entries.map((entry) => {
            if (entry.kind === 'steps') {
              const label =
                entry.running !== undefined
                  ? toolLabel(entry.running)
                  : entry.single !== undefined
                    ? toolLabel(entry.single)
                    : entry.count === 1
                      ? t('mobile.chat.thinking')
                      : t('mobile.chat.toolSteps', { count: entry.count });
              return (
                <button
                  key={entry.id}
                  type="button"
                  data-mobile-step-pill
                  onClick={() => { onOpenHood('tools'); }}
                  className="inline-flex min-h-11 max-w-full items-center gap-2 self-start text-left text-[13px] text-ink-faint transition-colors hover:text-ink-soft"
                >
                  <Icon
                    name={entry.running !== undefined ? 'task' : 'tool'}
                    size={12}
                    className={entry.running !== undefined ? 'text-accent' : 'text-ink-faint'}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                  <Icon name="chevron" size={12} className="shrink-0 opacity-75" />
                </button>
              );
            }
            return renderBlock(entry.block);
          })
        )}

        {fileChanges.length > 0 ? (
          <div
            data-mobile-changes-card
            className="w-full overflow-hidden rounded-2xl border border-hairline/90 bg-panel shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)]"
          >
            <button
              type="button"
              onClick={() => { onOpenHood('diff'); }}
              className="flex min-h-11 w-full items-center justify-between border-b border-hairline/65 px-3.5 text-left transition-colors hover:bg-ink/[0.02]"
            >
              <span className="text-[13.5px] font-semibold text-ink">
                {t('mobile.chat.changes', { count: fileChanges.length })}
              </span>
              <Icon name="chevron" size={12} className="text-ink-faint" />
            </button>
            <div className="divide-y divide-hairline/50">
              {fileChanges.slice(0, 4).map((change) => {
                const filename = change.path.split(/[\\/]/).pop() ?? change.path;
                return (
                  <button
                    key={change.id}
                    type="button"
                    data-mobile-change-file={change.id}
                    onClick={() => { onOpenHood('diff', change.id); }}
                    className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 text-left text-[13px] transition-colors hover:bg-ink/[0.02]"
                  >
                    <span className="min-w-0 truncate font-mono text-ink">{filename}</span>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums">
                      <span className="text-success">+{change.added}</span>{' '}
                      <span className="text-danger">-{change.removed}</span>
                    </span>
                  </button>
                );
              })}
              {fileChanges.length > 4 ? (
                <button
                  type="button"
                  onClick={() => { onOpenHood('diff'); }}
                  className="flex min-h-11 w-full items-center px-3.5 text-left text-[12.5px] text-ink-faint"
                >
                  {t('mobile.chat.changesMore', { count: fileChanges.length - 4 })}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
