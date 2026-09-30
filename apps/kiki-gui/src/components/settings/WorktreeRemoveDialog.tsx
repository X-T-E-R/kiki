/**
 * Worktree removal confirmation. Opening it inspects the checkout; the
 * confirm button stays disabled until that answer is in, and a checkout with
 * anything to lose switches to an explicit discard confirmation that names
 * the loss. The server only accepts a loss confirmation that matches a fresh
 * inspection, so a changed or expired result sends the user back to check.
 */

import { useCallback, useEffect, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import {
  hasLoss,
  worktreeApi,
  worktreeLoss,
  type WorktreeInspection,
  type WorktreeRecord,
  type WorktreeRemovalOutcome,
} from '../../lib/worktrees';
import { useConnection } from '../../state/connection';
import { FeedbackLine } from '../controls';
import { Dialog } from '../Dialog';
import { DANGER_BUTTON, SECONDARY_BUTTON } from '../ui';

export function outcomeReasonKey(outcome: WorktreeRemovalOutcome): I18nKey {
  return outcome === 'removed' ? 'st.worktrees.outcome.failed' : `st.worktrees.outcome.${outcome}`;
}

type Phase =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly inspection: WorktreeInspection; readonly stale?: boolean }
  | { readonly kind: 'check-failed'; readonly detail?: string }
  | { readonly kind: 'removing'; readonly inspection: WorktreeInspection };

export function WorktreeRemoveDialog({
  record,
  onClose,
  onInspected,
  onDone,
}: {
  record: WorktreeRecord;
  onClose: () => void;
  onInspected: (inspection: WorktreeInspection) => void;
  onDone: (outcome: WorktreeRemovalOutcome) => void;
}) {
  const { client } = useConnection();
  const { t, tp, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [error, setError] = useState<string | null>(null);

  const inspect = useCallback((stale = false) => {
    setPhase({ kind: 'checking' });
    void worktreeApi(client).inspect(record.id)
      .then((inspection) => {
        onInspected(inspection);
        setPhase(inspection.failed ? { kind: 'check-failed' } : { kind: 'ready', inspection, stale });
      })
      .catch((cause: unknown) => { setPhase({ kind: 'check-failed', detail: errorText(locale, cause) }); });
  }, [client, locale, onInspected, record.id]);

  // Inspect once per open; `inspect` is stable for a given record.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { inspect(); }, [record.id]);

  const remove = (inspection: WorktreeInspection) => {
    const loss = worktreeLoss(inspection);
    setError(null);
    setPhase({ kind: 'removing', inspection });
    void worktreeApi(client).remove(record.id, hasLoss(loss) ? { confirmLoss: loss } : {})
      .then(({ outcome }) => { onDone(outcome); })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : '';
        // The server refuses a confirmation older than 30s or one whose loss
        // no longer matches; both mean "look again".
        if (/inspection (changed|expired)/.test(message)) {
          inspect(true);
          return;
        }
        setError(errorText(locale, cause));
        setPhase({ kind: 'ready', inspection });
      });
  };

  const inspection = phase.kind === 'ready' || phase.kind === 'removing' ? phase.inspection : undefined;
  const loss = inspection === undefined ? undefined : worktreeLoss(inspection);
  const lossy = loss !== undefined && hasLoss(loss);
  const busy = phase.kind === 'removing';
  const title = t('st.worktrees.removeTitle', { branch: record.branch });

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={title} overlayId="worktree-remove-dialog" role="alertdialog">
      <h2 className="font-display text-[17px] font-semibold text-ink">{title}</h2>
      <p className="mt-2.5 text-[13px] leading-relaxed text-ink-soft">
        {t('st.worktrees.removeBody')}
      </p>
      <p className="mt-1 font-mono text-[11.5px] break-all text-ink-faint">{record.path}</p>

      <div data-worktree-remove-phase={phase.kind} className="mt-4" aria-live="polite">
        {phase.kind === 'checking' ? (
          <p className="text-[12.5px] text-ink-faint">{t('st.worktrees.removeChecking')}</p>
        ) : phase.kind === 'check-failed' ? (
          <div className="rounded-md border border-amber-rule/60 bg-amber-rule/10 px-3 py-2 text-[12.5px] leading-relaxed text-ink">
            <p>{t('st.worktrees.removeCheckFailed')}</p>
            {phase.detail !== undefined ? <p className="mt-1 font-mono text-[11px] text-ink-soft">{phase.detail}</p> : null}
          </div>
        ) : lossy && inspection !== undefined ? (
          <div data-worktree-loss className="rounded-md border-l-2 border-danger bg-danger/5 px-3 py-2.5">
            {phase.kind === 'ready' && phase.stale === true ? (
              <p className="mb-1.5 text-[12.5px] text-ink">{t('st.worktrees.removeStale')}</p>
            ) : null}
            <p className="text-[12.5px] font-semibold text-danger">{t('st.worktrees.lossTitle')}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[12.5px] leading-relaxed text-ink">
              {inspection.dirtyFiles > 0 ? <li>{tp('st.worktrees.dirty', inspection.dirtyFiles)}</li> : null}
              {inspection.unpushedCommits > 0 ? <li>{tp('st.worktrees.unpushed', inspection.unpushedCommits)}</li> : null}
              {inspection.ignoredNonDisposable.length > 0 ? (
                <li>{t('st.worktrees.ignored', { names: inspection.ignoredNonDisposable.slice(0, 5).join(', ') })}</li>
              ) : null}
            </ul>
          </div>
        ) : (
          <p data-worktree-clean className="text-[12.5px] text-ink-soft">{t('st.worktrees.removeClean')}</p>
        )}
        {inspection !== undefined && record.branchCreated ? (
          <p className="mt-2 text-[12px] leading-snug text-ink-faint">{t('st.worktrees.branchNote', { branch: record.branch })}</p>
        ) : null}
        {error !== null ? <div className="mt-2"><FeedbackLine feedback={{ tone: 'error', text: error }} /></div> : null}
      </div>

      <div className="mt-6 flex flex-wrap justify-end gap-2.5">
        <button type="button" data-autofocus className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        {phase.kind === 'check-failed' ? (
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { inspect(); }}>{t('st.worktrees.retry')}</button>
        ) : (
          <button
            type="button"
            data-worktree-remove-confirm={lossy ? 'loss' : 'clean'}
            className={DANGER_BUTTON}
            disabled={inspection === undefined || busy}
            onClick={() => { if (inspection !== undefined) remove(inspection); }}
          >
            {lossy ? t('st.worktrees.removeConfirmLoss') : t('st.worktrees.removeConfirm')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
