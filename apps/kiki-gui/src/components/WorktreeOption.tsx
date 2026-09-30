/**
 * The /new opt-in for worktree isolation. Off by default and never
 * remembered: a session runs in the current checkout unless this is turned on
 * for this one draft. Shown only once the target folder is known to be a Git
 * checkout — any other state (unknown, not a repository, remote) renders
 * nothing rather than a disabled switch with an explanation.
 *
 * Turning it on asks once (path, branch, cleanup), with a "don't ask again"
 * that Settings → General can bring back (`worktreeSkipConfirm`).
 */

import { useState } from 'react';

import { readSettings, writeSettings } from '@kiki/session-core/settings';
import { useI18n } from '../i18n';
import { ConfirmDialog } from './ConfirmDialog';
import type { NewSessionDraftState } from './NewSessionDraft';

export function WorktreeOption({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [skipConfirm, setSkipConfirm] = useState(false);
  const availability = state.worktreeAvailability;
  if (availability === undefined || availability.kind !== 'ready') return null;
  const checked = state.worktreeRequested;
  const hint = checked ? t('worktree.newHint') : undefined;

  const request = (on: boolean) => {
    if (!on || readSettings().worktreeSkipConfirm) {
      state.setWorktreeRequested(on);
      return;
    }
    setSkipConfirm(false);
    setConfirming(true);
  };
  const confirm = () => {
    if (skipConfirm) writeSettings({ worktreeSkipConfirm: true });
    setConfirming(false);
    state.setWorktreeRequested(true);
  };

  return (
    <div data-new-worktree={availability.kind} className="mt-2 flex min-w-0 flex-col items-start">
      <label className={`inline-flex min-h-7 items-center gap-2 pointer-coarse:min-h-11 ${state.busy ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          data-new-worktree-toggle
          className="peer sr-only"
          checked={checked}
          disabled={state.busy}
          aria-describedby={hint === undefined ? undefined : 'new-worktree-hint'}
          onChange={(event) => { request(event.target.checked); }}
        />
        <span
          aria-hidden
          className={`relative inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-selected-ink ${
            checked ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
              checked ? 'translate-x-[13px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
            }`}
          />
        </span>
        <span className={`text-[12px] leading-4 ${state.busy ? 'text-ink-faint' : checked ? 'text-ink' : 'text-ink-soft'}`}>
          {t('worktree.newToggle')}
        </span>
      </label>
      {hint === undefined ? null : (
        <p id="new-worktree-hint" data-new-worktree-hint className="anim-enter min-w-0 pl-8 text-[12px] leading-4 text-ink-soft">
          {hint}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        overlayId="confirm-new-worktree"
        tone="default"
        title={t('worktree.confirmTitle')}
        body={t('worktree.confirmBody', { root: availability.root })}
        consequences={[
          t('worktree.confirmBranch'),
          t('worktree.confirmCleanup'),
        ]}
        confirmLabel={t('worktree.confirmOk')}
        onConfirm={confirm}
        onCancel={() => { setConfirming(false); }}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={skipConfirm}
          data-new-worktree-skip-confirm
          onClick={() => { setSkipConfirm((value) => !value); }}
          className="mt-3 flex min-h-7 items-center gap-2 text-[12.5px] text-ink-soft transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none pointer-coarse:min-h-10"
        >
          <span
            aria-hidden
            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-[var(--kiki-motion-quick)] ${
              skipConfirm ? 'border-selected-ink/45 bg-selected text-selected-ink' : 'border-hairline-strong bg-paper'
            }`}
          >
            {skipConfirm ? (
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 6.2 4.8 8.5 9.5 3.5" />
              </svg>
            ) : null}
          </span>
          {t('worktree.confirmSkip')}
        </button>
      </ConfirmDialog>
    </div>
  );
}
