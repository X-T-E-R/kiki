/**
 * Needs you: every pending approval and question in the session, from any
 * depth of the agent tree, gathered at the top of the inspector. Each item
 * names where it came from (the agent's trail, clickable to inspect it) and
 * a plain approval is decided in place — no need to open the subagent.
 *
 * Requests that need more than yes/no (SSH logins, external permission
 * options, plan reviews) and questions hand off to the composer tray, which
 * holds the full card.
 */

import { memo, useState } from 'react';

import { MAIN_AGENT_ID, type AgentForest, type ApprovalBlock, type QuestionBlock } from '@kiki/session-core/session';
import { useI18n } from '../../i18n';
import { pushToast } from '../../lib/toasts';
import { externalPermissionFromDisplay } from '../Interactions';
import { agentTrail } from './agentRoster';
import { RAIL_MARK } from './InspectorAgents';
import { INSPECTOR_HEAD } from './InspectorSection';

export type PendingItem = ApprovalBlock | QuestionBlock;

function itemId(item: PendingItem): string {
  return item.kind === 'approval' ? item.request.approval_id : item.request.question_id;
}

/** A yes/no approval the rail can decide without the full card. */
function inlineDecidable(item: PendingItem): item is ApprovalBlock {
  if (item.kind !== 'approval' || item.request.ssh !== undefined) return false;
  const display = item.request.tool_input_display;
  if (externalPermissionFromDisplay(display) !== undefined) return false;
  const kind = typeof display === 'object' && display !== null ? (display as { kind?: unknown }).kind : undefined;
  return kind !== 'plan_enter' && kind !== 'plan_exit' && kind !== 'plan_review';
}

/** The object of the request in a few words: the command, the file, the action. */
function subject(item: PendingItem, fallback: string): string {
  if (item.kind === 'question') return item.request.questions[0]?.header ?? item.request.questions[0]?.question ?? fallback;
  const display = item.request.tool_input_display as { kind?: string; command?: string; path?: string; url?: string; query?: string } | null;
  if (display !== null && typeof display === 'object') {
    if (typeof display.command === 'string' && display.command !== '') return display.command.split('\n', 1)[0]!;
    if (typeof display.path === 'string' && display.path !== '') return display.path.split(/[\\/]/).filter(Boolean).pop() ?? display.path;
    if (typeof display.url === 'string' && display.url !== '') return display.url;
    if (typeof display.query === 'string' && display.query !== '') return display.query;
  }
  return item.request.action.replace(/^Run:\s*/, '');
}

const MAX_SHOWN = 3;

const ACTION = 'h-7 shrink-0 rounded-md px-2 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:opacity-50 pointer-coarse:h-9';

export const InspectorNeedsYou = memo(function InspectorNeedsYou({
  items,
  forest,
  onResolveApproval,
  onReview,
  onInspect,
}: {
  items: readonly PendingItem[];
  forest: AgentForest;
  onResolveApproval?: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  /** Focus the item in the composer tray (full card). */
  onReview?: (kind: 'approval' | 'question', id: string) => void;
  /** Turn the inspector to the agent that asked. */
  onInspect?: (agentId: string) => void;
}) {
  const { t, tp } = useI18n();
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  // A long queue keeps the rail usable: the first few, then the rest on demand.
  const shown = showAll || items.length <= MAX_SHOWN + 1 ? items : items.slice(0, MAX_SHOWN);
  const hidden = items.length - shown.length;
  const decide = (item: ApprovalBlock, decision: 'approved' | 'rejected') => {
    if (onResolveApproval === undefined) return;
    const id = item.request.approval_id;
    setSending((current) => new Set(current).add(id));
    void onResolveApproval(id, decision)
      .catch((error: unknown) => {
        pushToast({ tone: 'error', text: t('inspector.resolveFailed', { detail: error instanceof Error ? error.message : String(error) }) });
      })
      .finally(() => {
        setSending((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      });
  };
  return (
    <section data-inspector-needs-you="" aria-label={t('inspector.needsYou')} className="-mx-2 rounded-xl bg-attention-soft/60 px-2 pt-1.5 pb-1">
      <h3 className="flex h-6 items-center gap-1.5 px-0.5">
        <span className={INSPECTOR_HEAD.replace('text-ink-soft', 'text-attention')}>{t('inspector.needsYou')}</span>
        <span className="text-[12px] text-attention tabular-nums">{items.length}</span>
      </h3>
      <ul className="divide-y divide-attention/10">
        {shown.map((item) => {
          const id = itemId(item);
          const origin = item.originUnknown === true ? undefined : item.originAgentId;
          const fromSub = origin !== undefined && origin !== MAIN_AGENT_ID && forest.byId[origin] !== undefined;
          const trail = fromSub
            ? [...agentTrail(forest, origin), forest.byId[origin]!.label]
            : [t('rail.ownerMain')];
          const busy = sending.has(id);
          const inline = inlineDecidable(item) && onResolveApproval !== undefined;
          const what = subject(item, t('inspector.questionItem'));
          return (
            <li key={id} data-needs-you-item={id} data-needs-you-origin={origin ?? MAIN_AGENT_ID} className="py-1.5">
              <div className="flex min-w-0 items-start">
                <span className={RAIL_MARK}>
                  <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-attention" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-baseline gap-1.5 leading-5">
                    <span className="shrink-0 text-[13px] font-medium text-ink">
                      {item.kind === 'approval' ? item.request.tool_name : t('pending.kind.question')}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[12px] text-ink-soft" title={item.kind === 'approval' ? item.request.action : what}>{what}</span>
                  </p>
                  {onInspect !== undefined && fromSub ? (
                    <button
                      type="button"
                      data-needs-you-from={origin}
                      onClick={() => { onInspect(origin); }}
                      title={trail.join(' › ')}
                      className="-mx-1 block max-w-full truncate rounded px-1 text-left text-[12px] leading-[18px] text-ink-faint transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                    >
                      {t('inspector.needsYouFrom', { path: trail.join(' › ') })}
                    </button>
                  ) : (
                    <p className="truncate text-[12px] leading-[18px] text-ink-faint" title={trail.join(' › ')}>
                      {t('inspector.needsYouFrom', { path: trail.join(' › ') })}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-1 ml-3.5 flex items-center gap-1">
                {inline ? (
                  <>
                    <button
                      type="button"
                      data-needs-you-approve={id}
                      disabled={busy}
                      onClick={() => { decide(item, 'approved'); }}
                      className={`${ACTION} bg-accent text-primary-foreground hover:bg-accent-deep`}
                    >
                      {t('inspector.approveInline')}
                    </button>
                    <button
                      type="button"
                      data-needs-you-reject={id}
                      disabled={busy}
                      onClick={() => { decide(item, 'rejected'); }}
                      className={`${ACTION} text-ink-soft hover:bg-danger/[0.08] hover:text-danger`}
                    >
                      {t('inspector.rejectInline')}
                    </button>
                  </>
                ) : null}
                {onReview !== undefined ? (
                  <button
                    type="button"
                    data-inspector-review={id}
                    onClick={() => { onReview(item.kind, id); }}
                    className={`${ACTION} ${inline ? 'ml-auto font-normal text-ink-faint hover:bg-ink/[0.05] hover:text-ink' : 'text-attention hover:bg-attention-soft'}`}
                  >
                    {item.kind === 'question' ? t('inspector.answer') : t('inspector.review')}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <button
          type="button"
          data-needs-you-more
          onClick={() => { setShowAll(true); }}
          className="mt-0.5 mb-0.5 ml-3.5 inline-flex h-7 items-center rounded-md px-1.5 -mx-1.5 text-[12.5px] font-medium text-attention transition-colors hover:bg-attention-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
        >
          {tp('inspector.needsYouMore', hidden)}
        </button>
      ) : null}
    </section>
  );
});
