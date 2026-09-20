/**
 * Compact history presentation: terminal interaction facts (resolved
 * approvals/questions), terminal prompt notices, transcript markers, settled
 * subagent lifecycle entries and compact subagent cards stay INLINE in the
 * timeline at their original position. Runs of ≥2 consecutive compact
 * entries fold into an expandable summary row so notification piles stop
 * flooding the log; failure-bearing runs retain a danger summary.
 */

import { memo, useState, type ReactNode } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type {
  ApprovalBlock,
  ApprovalResolution,
  DisplayNode,
  NoticeBlock,
  QuestionBlock,
} from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { RelativeTime } from './RelativeTime';

/** Marker notices (goal/plan/swarm/interruption …) are the neutral, transcript-owned ones. */
export function isMarkerNotice(block: NoticeBlock): boolean {
  return block.tone === 'neutral' && block.id.startsWith('agent-marker-');
}

export function isInterruptionNotice(block: NoticeBlock): boolean {
  return (
    block.id.includes('interruption') ||
    block.i18n?.key === 'transcript.marker.interruption'
  );
}

export function isAbortedPromptNotice(block: NoticeBlock): boolean {
  return block.tone === 'neutral' && block.id.startsWith('notice-aborted-');
}

export function isFailedPromptNotice(block: NoticeBlock): boolean {
  return block.tone === 'danger' && block.id.startsWith('notice-failed-');
}

export function isTerminalPromptNotice(block: NoticeBlock): boolean {
  return isAbortedPromptNotice(block) || isFailedPromptNotice(block);
}

/**
 * Locate a subagent card in the mounted timeline. When the card is folded
 * inside a collapsed history run, expand that run once so the card mounts and
 * return false (the caller retries); returns true once the card exists and
 * has been scrolled into view. Cards outside the mounted virtual window are
 * not found — the caller's bounded retry policy applies.
 */
export function revealSubagentCard(agentId: string): boolean {
  // Attribute-value comparison instead of a CSS.escape'd selector: jsdom (and
  // older engines) lack CSS.escape, and the mounted card set is small.
  const target = [...document.querySelectorAll('[data-subagent-id]')].find(
    (el) => el.getAttribute('data-subagent-id') === agentId,
  );
  if (target !== undefined) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }
  const blockId = `subagent-${agentId}`;
  for (const run of document.querySelectorAll('[data-history-run-member-ids]')) {
    const memberIds = (run.getAttribute('data-history-run-member-ids') ?? '').split(' ');
    if (!memberIds.includes(blockId)) continue;
    const toggle = run.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    toggle?.click();
    return false;
  }
  return false;
}

/** A run of consecutive compact entries folded behind one summary row. */
export interface HistoryRun {
  readonly kind: 'history-run';
  readonly id: string;
  readonly nodes: readonly DisplayNode[];
}

export type GroupedDisplayNode = DisplayNode | HistoryRun;

/**
 * Fold runs of ≥2 consecutive compact entries. Single compact entries stay
 * individual one-liners; any non-compact node (user/assistant/tool or pending
 * interaction) breaks the run, so a group never spans a user message. The
 * caller decides which terminal failures are historical enough to compact.
 */
export function groupHistoryRuns(
  nodes: readonly DisplayNode[],
  isCompact: (node: DisplayNode) => boolean,
): readonly GroupedDisplayNode[] {
  const out: GroupedDisplayNode[] = [];
  let run: DisplayNode[] = [];
  const flush = (): void => {
    if (run.length >= 2) {
      out.push({ kind: 'history-run', id: `history-run-${run[0]!.id}`, nodes: run });
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const node of nodes) {
    if (isCompact(node)) {
      run.push(node);
      continue;
    }
    flush();
    out.push(node);
  }
  flush();
  return out;
}

/** groupHistoryRuns rebuilds the wrapper per publish; compare member-wise. */
export function historyRunsEqual(a: GroupedDisplayNode, b: GroupedDisplayNode): boolean {
  if (a === b) return true;
  if (a.kind !== 'history-run' || b.kind !== 'history-run') return false;
  return (
    a.id === b.id &&
    a.nodes.length === b.nodes.length &&
    a.nodes.every((node, index) => node === b.nodes[index])
  );
}

const RESOLUTION_KEY: Record<ApprovalResolution['decision'], I18nKey> = {
  approved: 'ia.resolution.approved',
  rejected: 'ia.resolution.rejected',
  cancelled: 'ia.resolution.cancelled',
  expired: 'ia.resolution.expired',
  resolved_elsewhere: 'ia.resolution.resolvedElsewhere',
};

/**
 * One-line terminal fact for a resolved approval or question: outcome glyph +
 * origin tag (child-origin cards) + subject + resolution label + when. The
 * pending counterparts keep their full interactive cards; this is history.
 */
export const HistoryLine = memo(function HistoryLine({
  node,
  originName,
}: {
  node: ApprovalBlock | QuestionBlock;
  originName?: string;
}) {
  const { t, time } = useI18n();
  let glyph: string;
  let glyphClass: string;
  let text: string;
  let stateLabel: string;
  let at: string | undefined;
  if (node.kind === 'approval') {
    const resolution = node.resolution;
    if (resolution === undefined) return null;
    const negative = resolution.decision === 'rejected' || resolution.decision === 'cancelled';
    glyph = resolution.decision === 'approved' ? '✓' : negative ? '×' : '-';
    glyphClass = resolution.decision === 'approved'
      ? 'text-success'
      : negative
        ? 'text-danger'
        : 'text-ink-faint';
    text = `${node.request.tool_name} · ${node.request.action}`;
    stateLabel = t(RESOLUTION_KEY[resolution.decision]);
    at = resolution.resolvedAt;
  } else {
    const outcome = node.outcome;
    if (outcome === undefined) return null;
    glyph = outcome.kind === 'answered' ? '✓' : '-';
    glyphClass = outcome.kind === 'answered' ? 'text-success' : 'text-ink-faint';
    text = node.request.questions[0]?.question ?? '';
    stateLabel = t(`ia.question.${outcome.kind}` as I18nKey);
    at = outcome.kind === 'expired' ? undefined : outcome.at;
  }
  return (
    <div data-history-line className="anim-enter ml-6 flex items-center gap-2 py-0.5">
      <span aria-hidden className={`w-3.5 shrink-0 text-center text-[10px] ${glyphClass}`}>
        {glyph}
      </span>
      <span className="min-w-0 truncate text-[11px] text-ink-faint">
        {originName === undefined ? '' : `${originName} · `}
        {text}
      </span>
      <span className="shrink-0 text-[10px] text-ink-faint">{stateLabel}</span>
      {at === undefined ? null : (
        <span className="ml-auto shrink-0 font-mono text-[9.5px] text-ink-faint">
          <RelativeTime at={at} />
        </span>
      )}
    </div>
  );
});

/**
 * Folded history run: a centered hairline summary ("Activity history · N")
 * matching the Notice divider idiom; expanding lists the members in order,
 * each rendered by the transcript through `renderMember`.
 */
export function HistoryRunRow({
  run,
  renderMember,
}: {
  run: HistoryRun;
  renderMember: (node: DisplayNode) => ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const failureCount = run.nodes.filter(
    (node) => node.kind === 'notice' && isFailedPromptNotice(node),
  ).length;
  const hasFailures = failureCount > 0;
  return (
    <div
      data-history-run={run.id}
      data-history-run-member-ids={run.nodes.map((node) => node.id).join(' ')}
      data-history-run-failures={hasFailures ? failureCount : undefined}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => { setExpanded((value) => !value); }}
        className="anim-enter group flex w-full items-center gap-3 py-1"
      >
        <span className={`h-px flex-1 ${hasFailures ? 'bg-danger/30' : 'bg-hairline'}`} />
        <span className={`flex items-center gap-1.5 text-[11px] transition-colors ${hasFailures ? 'font-medium text-danger group-hover:text-danger' : 'text-ink-faint group-hover:text-ink'}`}>
          {hasFailures
            ? t('activity.historyWithFailures', { count: run.nodes.length, failureCount })
            : t('activity.history', { count: run.nodes.length })}
          <span
            aria-hidden
            className={`text-[9px] transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
        </span>
        <span className={`h-px flex-1 ${hasFailures ? 'bg-danger/30' : 'bg-hairline'}`} />
      </button>
      {expanded ? (
        <div data-history-run-members className="flex flex-col gap-1">
          {run.nodes.map((node) => (
            <div key={node.id}>{renderMember(node)}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
