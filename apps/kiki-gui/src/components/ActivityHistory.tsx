/**
 * Compact history presentation: terminal interaction facts (resolved
 * approvals/questions), terminal prompt notices, transcript markers, settled
 * subagent lifecycle entries and compact subagent cards stay INLINE in the
 * timeline at their original position, in time order.
 *
 * They are NOT folded behind a counter. The previous "N completed actions"
 * summary row replaced a pile of named facts with one number, which is the
 * aggregate pattern the reference timelines draw complaints for: it hides the
 * file that was touched and the command that ran, and it cannot be scanned.
 * A settled action is quiet instead of hidden — the activity lane's glyph
 * column keeps a long run readable without a lid on it.
 */

import { memo } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type {
  ApprovalBlock,
  ApprovalResolution,
  NoticeBlock,
  QuestionBlock,
} from '@kiki/session-core/session';
import { useI18n } from '../i18n';
import { reviewerLabel, reviewerTooltip } from './approvalReviewer';
import { RelativeTime } from './RelativeTime';
import { Icon, type IconName } from './icons';
import { ActivityRow, type ActivityTone } from './timeline/ActivityRow';

/** Marker notices (goal/plan/interruption …) are the neutral, transcript-owned ones. */
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
 * Locate a subagent card in the mounted timeline and scroll it into view.
 * Returns false when the card is not mounted — it sits outside the virtual
 * window, and the caller's bounded retry policy applies while the list
 * scrolls. Nothing has to be unfolded first: settled entries render in place,
 * so a mounted row is always a visible row.
 */
export function revealSubagentCard(agentId: string): boolean {
  // Attribute-value comparison instead of a CSS.escape'd selector: jsdom (and
  // older engines) lack CSS.escape, and the mounted card set is small.
  const target = [...document.querySelectorAll('[data-subagent-id]')].find(
    (el) => el.getAttribute('data-subagent-id') === agentId,
  );
  if (target === undefined) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

const RESOLUTION_KEY: Record<ApprovalResolution['decision'], I18nKey> = {
  approved: 'ia.resolution.approved',
  rejected: 'ia.resolution.rejected',
  cancelled: 'ia.resolution.cancelled',
  expired: 'ia.resolution.expired',
  resolved_elsewhere: 'ia.resolution.resolvedElsewhere',
};

/**
 * A settled approval or question as one activity line: the decision is the
 * LABEL (what happened), the tool and action are the detail, and the time
 * lands in the shared meta column. Pending counterparts keep their full
 * interactive card — this is the record it leaves behind.
 */
export const HistoryLine = memo(function HistoryLine({
  node,
  originName,
}: {
  node: ApprovalBlock | QuestionBlock;
  originName?: string;
}) {
  const { t } = useI18n();
  // The icon names the KIND of record (a decision gate, a question asked);
  // the label already states the outcome, so the picture never doubles as
  // a success tick. Only a refusal tints the line.
  let icon: IconName;
  let tone: ActivityTone;
  let text: string;
  let stateLabel: string;
  let stateTitle: string | undefined;
  let at: string | undefined;
  if (node.kind === 'approval') {
    const resolution = node.resolution;
    if (resolution === undefined) return null;
    const negative = resolution.decision === 'rejected' || resolution.decision === 'cancelled';
    icon = 'gate';
    tone = negative ? 'danger' : 'plain';
    text = `${node.request.tool_name} · ${node.request.action}`;
    stateLabel = t(RESOLUTION_KEY[resolution.decision]);
    if (resolution.reviewer !== undefined) {
      stateLabel = reviewerLabel(resolution.decision, resolution.reviewer, t, stateLabel);
      stateTitle = reviewerTooltip(resolution.reviewer, t);
    }
    at = resolution.resolvedAt;
  } else {
    const outcome = node.outcome;
    if (outcome === undefined) return null;
    icon = 'ask';
    tone = 'plain';
    text = node.request.questions[0]?.question ?? '';
    stateLabel = t(`ia.question.${outcome.kind}` as I18nKey);
    at = outcome.kind === 'expired' ? undefined : outcome.at;
  }
  return (
    <ActivityRow
      attrs={{ 'data-history-line': true }}
      glyph={<Icon name={icon} />}
      tone={tone}
      label={stateLabel}
      title={stateTitle}
      detail={originName === undefined ? text : `${originName} · ${text}`}
      meta={at === undefined ? undefined : <RelativeTime at={at} />}
    />
  );
});

/* The folded "N completed actions" run is retired; settled entries render in
   place. Kept intentionally absent rather than hidden behind a preference:
   two ways to read the same history is worse than one good one. */
