/**
 * The strip a temporary conversation carries above its composer: what it is
 * (kept out of history, deleted when it ends) and the two ways out of that,
 * keep it as an ordinary conversation or end it now. Ending is confirmed;
 * a worktree with work the user could lose is kept unless they choose to
 * remove it, and removal then confirms the loss they were shown.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { Session, WorktreeInspection } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { pushToast } from '../lib/toasts';
import { hasLoss, worktreeApi, worktreeLoss } from '../lib/worktrees';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { useGuardedNavigate } from './dirtyGuard';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

const STRIP_BUTTON = 'inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:h-11';

export function EphemeralBar({
  session,
  busy,
  onSaved,
}: {
  session: Session;
  /** A turn is running: saving waits for it (the server answers SESSION_BUSY). */
  busy: boolean;
  onSaved: () => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [ending, setEnding] = useState(false);

  const save = () => {
    setSaving(true);
    void client.saveEphemeralSession(session.id)
      .then(() => {
        pushToast({ tone: 'success', text: t('ephemeral.saved') });
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onSaved();
      })
      .catch((cause: unknown) => {
        pushToast({ tone: 'error', text: t('ephemeral.saveFailed', { detail: errorText(locale, cause) }) });
      })
      .finally(() => { setSaving(false); });
  };

  return (
    <div data-ephemeral-bar className="mx-auto mb-1.5 flex w-full max-w-[var(--kiki-agent-column,640px)] min-w-0 items-center gap-2 rounded-lg border border-dashed border-hairline-strong px-2.5 py-0.5">
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-soft">{t('ephemeral.strip')}</span>
      <button
        type="button"
        data-ephemeral-save
        className={STRIP_BUTTON}
        disabled={busy || saving}
        title={busy ? t('ephemeral.saveBusy') : undefined}
        aria-describedby={busy ? 'ephemeral-save-busy' : undefined}
        onClick={save}
      >
        {t('ephemeral.save')}
      </button>
      {busy ? <span id="ephemeral-save-busy" className="sr-only">{t('ephemeral.saveBusy')}</span> : null}
      <button type="button" data-ephemeral-end className={STRIP_BUTTON} onClick={() => { setEnding(true); }}>
        {t('ephemeral.end')}
      </button>
      {ending ? <EndEphemeralDialog session={session} onClose={() => { setEnding(false); }} /> : null}
    </div>
  );
}

type WorktreeCheck =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'clean' }
  | { readonly kind: 'loss'; readonly inspection: WorktreeInspection }
  /** Inspection failed: the worktree is kept, there is nothing safe to confirm. */
  | { readonly kind: 'unknown' };

function EndEphemeralDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useGuardedNavigate();
  const worktree = session.worktree;
  const worktreeId = worktree?.worktree_id;
  const [check, setCheck] = useState<WorktreeCheck>(() => (worktreeId === undefined ? { kind: 'none' } : { kind: 'checking' }));
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (worktreeId === undefined) return;
    let live = true;
    void worktreeApi(client).inspect(worktreeId)
      .then((inspection) => {
        if (live) setCheck(hasLoss(worktreeLoss(inspection)) ? { kind: 'loss', inspection } : { kind: 'clean' });
      })
      .catch(() => { if (live) setCheck({ kind: 'unknown' }); });
    return () => { live = false; };
  }, [client, worktreeId]);

  const confirm = () => {
    setBusy(true);
    setError(null);
    // The worktree stays unless the user chose removal. A clean one is removed
    // with the session; one holding work is removed afterwards, confirming
    // exactly the loss that was inspected and shown.
    const endWith = worktree === undefined ? undefined
      : removeWorktree && check.kind === 'clean' ? 'remove' : 'keep';
    void client.endEphemeralSession(session.id, endWith)
      .then(async () => {
        if (removeWorktree && check.kind === 'loss' && worktreeId !== undefined) {
          await worktreeApi(client).remove(worktreeId, { confirmLoss: worktreeLoss(check.inspection) })
            .catch((cause: unknown) => {
              pushToast({ tone: 'error', text: t('ephemeral.endFailed', { detail: errorText(locale, cause) }) });
            });
        }
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        onClose();
        navigate('/new');
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(t('ephemeral.endFailed', { detail: errorText(locale, cause) }));
      });
  };

  const title = t('ephemeral.endTitle');
  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={title} overlayId="ephemeral-end">
      <h2 className="font-display text-[17px] font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t('ephemeral.endBody')}</p>
      {(check.kind === 'loss' || check.kind === 'clean') && worktree !== undefined ? (
        <fieldset data-ephemeral-end-worktree={check.kind} className="mt-4 rounded-lg border border-hairline px-3 py-2.5">
          {/* With work at stake the legend says so; a clean checkout is named only. */}
          <legend className={`px-1 text-[12px] leading-snug text-ink-soft ${check.kind === 'clean' ? 'font-mono break-all' : ''}`}>
            {check.kind === 'loss' ? t('ephemeral.endWorktree', { branch: worktree.branch }) : worktree.branch}
          </legend>
          {([false, true] as const).map((remove) => (
            <label key={String(remove)} className="flex min-h-8 cursor-pointer items-center gap-2.5 text-[13px] text-ink pointer-coarse:min-h-11">
              <input
                type="radio"
                name="ephemeral-end-worktree"
                data-ephemeral-end-worktree-choice={remove ? 'remove' : 'keep'}
                checked={removeWorktree === remove}
                disabled={busy}
                onChange={() => { setRemoveWorktree(remove); }}
                className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              {t(remove ? 'ephemeral.endWorktreeRemove' : 'ephemeral.endWorktreeKeep')}
            </label>
          ))}
        </fieldset>
      ) : null}
      {error !== null ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2.5">
        <button type="button" data-autofocus className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          data-ephemeral-end-confirm
          className={PRIMARY_BUTTON}
          disabled={busy || check.kind === 'checking'}
          onClick={confirm}
        >
          {t('ephemeral.endConfirm')}
        </button>
      </div>
    </Dialog>
  );
}

/** The dashed "Temporary" word a temporary conversation wears in its header and sidebar row. */
export function TemporaryMark({ className = '' }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span
      data-ephemeral-mark
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-dashed border-hairline-strong px-1.5 text-[11px] leading-none font-medium text-ink-soft ${className}`}
    >
      {t('ephemeral.badge')}
    </span>
  );
}
