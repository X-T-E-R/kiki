/**
 * The /new opt-in for worktree isolation. Off by default and never
 * remembered: a session runs in the current checkout unless this is turned on
 * for this one draft. Shown only once the target folder is known; a folder
 * that is not a Git repository, or a remote workspace, gets the reason
 * instead of a live switch.
 */

import { useI18n } from '../i18n';
import type { NewSessionDraftState } from './NewSessionDraft';

export function WorktreeOption({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const availability = state.worktreeAvailability;
  if (availability === undefined || availability.kind === 'hidden') return null;
  const disabled = availability.kind !== 'ready' || state.busy;
  const checked = availability.kind === 'ready' && state.worktreeRequested;
  // The explanation shows once it matters: after opting in, or when the
  // option cannot be used and the reason is the whole message.
  const hint = availability.kind === 'ready'
    ? (checked ? t('worktree.newHint') : undefined)
    : availability.kind === 'remote'
      ? t('worktree.newUnavailableRemote')
      : t('worktree.newUnavailableNotGit');

  return (
    <div data-new-worktree={availability.kind} className="mt-2 flex min-w-0 flex-col items-start">
      <label className={`inline-flex min-h-7 items-center gap-2 pointer-coarse:min-h-11 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          data-new-worktree-toggle
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : 'new-worktree-hint'}
          onChange={(event) => { state.setWorktreeRequested(event.target.checked); }}
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
        <span className={`text-[12px] leading-4 ${disabled ? 'text-ink-faint' : checked ? 'text-ink' : 'text-ink-soft'}`}>
          {t('worktree.newToggle')}
        </span>
      </label>
      {hint === undefined ? null : (
        <p id="new-worktree-hint" data-new-worktree-hint className={`anim-enter min-w-0 pl-8 text-[12px] leading-4 ${availability.kind === 'ready' ? 'text-ink-soft' : 'text-ink-faint'}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
