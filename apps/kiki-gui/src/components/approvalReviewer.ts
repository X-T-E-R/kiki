/**
 * Copy for approvals an automatic reviewer decided (Approve-for-me mode):
 * "Approved by reviewer · <reason>", with backend + confidence in a tooltip.
 * Shared by the resolved card line and the compact history line.
 */

import type { I18nKey, I18nParams } from '@kiki/session-core/i18n';
import type { ApprovalResolution, ApprovalReviewer } from '@kiki/session-core/session';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** Reviewer outcome label; decisions other than approve/reject keep `fallback`. */
export function reviewerLabel(
  decision: ApprovalResolution['decision'],
  reviewer: ApprovalReviewer,
  t: Translate,
  fallback: string,
): string {
  const head =
    decision === 'approved'
      ? t('ia.reviewer.approved')
      : decision === 'rejected'
        ? t('ia.reviewer.rejected')
        : fallback;
  const reason = reviewer.reason.trim();
  return reason === '' ? head : `${head} · ${reason}`;
}

export function reviewerTooltip(reviewer: ApprovalReviewer, t: Translate): string {
  const backend = t(reviewer.backend === 'jev' ? 'ia.reviewer.backend.jev' : 'ia.reviewer.backend.model');
  // Confidence arrives as 0–1; tolerate a 0–100 value from older writers.
  const raw = Number.isFinite(reviewer.confidence) ? reviewer.confidence : 0;
  const percent = Math.round(raw <= 1 ? raw * 100 : raw);
  return t('ia.reviewer.tooltip', { backend, confidence: String(percent) });
}
