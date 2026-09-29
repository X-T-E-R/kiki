/**
 * Archive confirmation for a worktree session, with the one extra choice it
 * needs: also remove the worktree. Off by default. Removal is asked without
 * a loss confirmation, so the server keeps any checkout with uncommitted
 * changes, unpushed commits or other non-disposable files; discarding those
 * is a deliberate step in Settings › Workspaces.
 */

import { useState } from 'react';

import type { Session } from '@kiki/protocol';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../i18n';
import { worktreeApi, type WorktreeRemovalOutcome } from '../lib/worktrees';
import { useConnection } from '../state/connection';
import { Dialog } from './Dialog';
import { outcomeReasonKey } from './settings/WorktreeRemoveDialog';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './ui';

export interface WorktreeArchiveResult {
  readonly tone: 'notice' | 'error';
  readonly text: string;
}

export function WorktreeArchiveDialog({
  session,
  onClose,
  onArchived,
}: {
  session: Session & { readonly worktree: NonNullable<Session['worktree']> };
  onClose: () => void;
  onArchived: (result: WorktreeArchiveResult | null) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const [removeWorktree, setRemoveWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = t('worktree.archiveTitle', { title: session.title !== '' ? session.title : t('sidebar.untitled') });
  const branch = session.worktree.branch;

  const describe = (outcome: WorktreeRemovalOutcome): WorktreeArchiveResult => {
    if (outcome === 'removed') return { tone: 'notice', text: t('worktree.archiveRemoved', { branch }) };
    if (outcome === 'retained_dirty' || outcome === 'retained_unpushed' || outcome === 'retained_ignored') {
      return { tone: 'notice', text: t('worktree.archiveKeptLoss', { branch }) };
    }
    const reason = t(outcomeReasonKey(outcome));
    const kept = outcome.startsWith('failed') ? `${reason} ${t('st.worktrees.keptAt', { path: session.metadata.cwd })}` : reason;
    return { tone: 'error', text: t('worktree.archiveKept', { branch, reason: kept }) };
  };

  const confirm = () => {
    setBusy(true);
    setError(null);
    void client.archiveSession(session.id)
      .then(async () => {
        if (!removeWorktree) return null;
        try {
          const { outcome } = await worktreeApi(client).remove(session.worktree.worktree_id);
          return describe(outcome);
        } catch (cause: unknown) {
          return { tone: 'error' as const, text: t('worktree.archiveKept', { branch, reason: errorText(locale, cause) }) };
        }
      })
      .then(onArchived)
      .catch((cause: unknown) => {
        setBusy(false);
        setError(errorText(locale, cause));
      });
  };

  return (
    <Dialog onClose={() => { if (!busy) onClose(); }} ariaLabel={title} overlayId="sidebar-confirm-archive-worktree">
      <h2 className="font-display text-[17px] font-semibold text-ink">{title}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{t('worktree.archiveBody')}</p>
      <label data-archive-remove-worktree className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-lg border border-hairline px-3 py-2.5 hover:border-hairline-strong">
        <input
          type="checkbox"
          checked={removeWorktree}
          disabled={busy}
          onChange={(event) => { setRemoveWorktree(event.target.checked); }}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span className="min-w-0">
          <span className="block text-[13px] text-ink">{t('worktree.archiveRemove')}</span>
          <span className="mt-0.5 block font-mono text-[11.5px] break-all text-ink-soft">{branch}</span>
          <span className="mt-1 block text-[12px] leading-snug text-ink-faint">{t('worktree.archiveRemoveHint')}</span>
        </span>
      </label>
      {error !== null ? <p role="alert" className="mt-2 font-mono text-[11px] text-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2.5">
        <button type="button" data-autofocus className={SECONDARY_BUTTON} disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" data-archive-confirm className={PRIMARY_BUTTON} disabled={busy} onClick={confirm}>
          {t('worktree.archiveConfirm')}
        </button>
      </div>
    </Dialog>
  );
}
