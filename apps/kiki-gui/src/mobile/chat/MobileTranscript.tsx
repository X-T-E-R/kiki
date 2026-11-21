import { useEffect, useMemo, useRef } from 'react';

import type { ApprovalDecision } from '@kiki/protocol';
import type { Block, ToolBlock } from '@kiki/session-core/session';

import { Icon } from '../../components/icons';
import { useI18n } from '../../i18n';
import { isInlineDecidable, summarizeApproval } from '../approvalSummary';
import { MobileMarkdown } from '../mobileMarkdown';
import { extractFileChanges, type HoodTab } from './LiftTheHoodSheet';

interface MobileTranscriptProps {
  readonly blocks: readonly Block[];
  readonly loaded: boolean;
  readonly hasMoreHistory: boolean;
  readonly loadingOlder: boolean;
  readonly onLoadOlder: () => void;
  readonly onOpenHood: (tab: HoodTab) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalDecision) => void;
  readonly onOpenWorkbench: () => void;
}

type RenderEntry =
  | { readonly kind: 'block'; readonly block: Block }
  | { readonly kind: 'step-group'; readonly id: string; readonly tools: readonly ToolBlock[]; readonly thinkingCount: number };

function groupMobileBlocks(blocks: readonly Block[]): readonly RenderEntry[] {
  const entries: RenderEntry[] = [];
  let pendingTools: ToolBlock[] = [];
  let pendingThinking = 0;

  const flushGroup = () => {
    if (pendingTools.length === 0 && pendingThinking === 0) return;
    const firstId = pendingTools[0]?.id ?? `think-${entries.length}`;
    entries.push({
      kind: 'step-group',
      id: `grp-${firstId}`,
      tools: pendingTools,
      thinkingCount: pendingThinking,
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

export function MobileTranscript({
  blocks,
  loaded,
  hasMoreHistory,
  loadingOlder,
  onLoadOlder,
  onOpenHood,
  onResolveApproval,
  onOpenWorkbench,
}: MobileTranscriptProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedBottomRef = useRef(true);

  const entries = useMemo(() => groupMobileBlocks(blocks), [blocks]);
  const fileChanges = useMemo(() => extractFileChanges(blocks), [blocks]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !pinnedBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, blocks]);

  return (
    <div
      ref={scrollRef}
      data-mobile-transcript
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
              disabled={loadingOlder}
              onClick={onLoadOlder}
              className="rounded-full border border-hairline bg-panel px-4 py-1.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-hairline-strong disabled:opacity-55"
            >
              {loadingOlder ? t('mobile.chat.loading') : t('mobile.chat.loadOlder')}
            </button>
          </div>
        ) : null}

        {!loaded ? (
          <p className="py-12 text-center text-[13.5px] text-ink-faint">{t('mobile.chat.loading')}</p>
        ) : entries.length === 0 ? (
          <div className="py-16 text-center">
            <p className="font-display text-[20px] text-ink-soft">{t('mobile.chat.emptyHint')}</p>
          </div>
        ) : (
          entries.map((entry) => {
            if (entry.kind === 'step-group') {
              const stepCount = entry.tools.length + entry.thinkingCount;
              const runningTool = entry.tools.find((tool) => tool.status === 'running');
              const label =
                runningTool !== undefined
                  ? `${runningTool.name}${runningTool.description ? ` · ${runningTool.description}` : ''}`
                  : stepCount === 1
                    ? entry.tools[0] !== undefined
                      ? `${entry.tools[0].name}${entry.tools[0].description ? ` · ${entry.tools[0].description}` : ''}`
                      : t('mobile.chat.thinking')
                    : t('mobile.chat.toolSteps', { count: stepCount });

              return (
                <button
                  key={entry.id}
                  type="button"
                  data-mobile-step-pill
                  onClick={() => { onOpenHood('tools'); }}
                  className="inline-flex max-w-full items-center gap-2 self-start py-1 text-left text-[13px] text-ink-faint transition-colors hover:text-ink-soft"
                >
                  <Icon
                    name={runningTool !== undefined ? 'task' : 'tool'}
                    size={12}
                    className={runningTool !== undefined ? 'text-accent' : 'text-ink-faint'}
                  />
                  <span className="min-w-0 truncate">{label}</span>
                  <Icon name="chevron" size={12} className="shrink-0 opacity-75" />
                </button>
              );
            }

            const block = entry.block;
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
              return (
                <div key={block.id} data-mobile-msg="assistant" className="w-full">
                  <MobileMarkdown content={block.text} />
                </div>
              );
            }

            if (block.kind === 'message') {
              return (
                <div key={block.id} data-mobile-msg="assistant" className="w-full">
                  <MobileMarkdown content={block.text} />
                </div>
              );
            }

            if (block.kind === 'approval' && block.resolution === undefined) {
              const approvalId = block.request.approval_id;
              const summary = summarizeApproval(block.request);
              return (
                <div
                  key={block.id}
                  data-mobile-inline-approval={approvalId}
                  className="rounded-2xl border border-hairline bg-panel p-3.5 shadow-xs"
                >
                  <p className="line-clamp-2 text-[14px] font-medium leading-[1.4] text-ink">{summary.headline}</p>
                  {summary.snippet !== undefined ? (
                    <pre className="mt-2 max-h-16 overflow-hidden whitespace-pre-wrap break-all rounded-xl bg-canvas/90 px-3 py-2 font-mono text-[12px] leading-[1.45] text-ink-soft">
                      {summary.snippet}
                    </pre>
                  ) : null}
                  <div className="mt-2.5 flex items-center gap-2">
                    {isInlineDecidable(block.request) ? (
                      <>
                        <button
                          type="button"
                          onClick={() => { onResolveApproval(approvalId, 'approved'); }}
                          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[13.5px] font-medium text-primary-foreground transition-colors hover:bg-accent-deep"
                        >
                          <Icon name="check" size={14} />
                          <span>{t('mobile.approval.approve')}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => { onResolveApproval(approvalId, 'rejected'); }}
                          className="inline-flex h-10 items-center gap-1.5 rounded-full border border-hairline bg-paper px-4 text-[13.5px] font-medium text-ink-soft transition-colors hover:text-ink"
                        >
                          <Icon name="cross" size={14} />
                          <span>{t('mobile.approval.reject')}</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={onOpenWorkbench}
                        className="inline-flex h-10 items-center gap-1 rounded-full border border-hairline bg-paper px-4 text-[13.5px] font-medium text-ink-soft transition-colors hover:text-ink"
                      >
                        <span>{t('mobile.approval.details')}</span>
                        <Icon name="chevron" size={12} />
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            return null;
          })
        )}

        {fileChanges.length > 0 ? (
          <button
            type="button"
            data-mobile-changes-card
            onClick={() => { onOpenHood('diff'); }}
            className="w-full overflow-hidden rounded-2xl border border-hairline/90 bg-panel text-left shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.04)] transition-colors hover:border-hairline-strong"
          >
            <div className="flex items-center justify-between border-b border-hairline/65 px-3.5 py-2.5">
              <span className="text-[13.5px] font-semibold text-ink">
                {t('mobile.chat.changes', { count: fileChanges.length })}
              </span>
              <Icon name="chevron" size={12} className="text-ink-faint" />
            </div>
            <div className="divide-y divide-hairline/50">
              {fileChanges.slice(0, 4).map((change) => {
                const filename = change.path.split(/[\\/]/).pop() ?? change.path;
                return (
                  <div key={change.id} className="flex items-center justify-between gap-2 px-3.5 py-2 text-[13px]">
                    <span className="min-w-0 truncate font-mono text-ink">{filename}</span>
                    <span className="shrink-0 font-mono text-[12px] tabular-nums">
                      <span className="text-success">+{change.added}</span>{' '}
                      <span className="text-danger">-{change.removed}</span>
                    </span>
                  </div>
                );
              })}
              {fileChanges.length > 4 ? (
                <div className="px-3.5 py-2 text-[12.5px] text-ink-faint">
                  {t('mobile.chat.changesMore', { count: fileChanges.length - 4 })}
                </div>
              ) : null}
            </div>
          </button>
        ) : null}
      </div>
    </div>
  );
}
