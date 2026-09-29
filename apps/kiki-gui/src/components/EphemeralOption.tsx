/**
 * The /new opt-in for a temporary conversation: kept out of history, search
 * and memory, deleted when it ends. Off by default; the choice holds for this
 * window only, so a fresh window never starts temporary unasked. Same switch
 * shape as the worktree option beside it.
 */

import { useI18n } from '../i18n';
import type { NewSessionDraftState } from './NewSessionDraft';

export function EphemeralOption({ state }: { state: NewSessionDraftState }) {
  const { t } = useI18n();
  const checked = state.ephemeral;
  return (
    <div data-new-ephemeral={checked || undefined} className="mt-2 flex min-w-0 flex-col items-start">
      <label className={`inline-flex min-h-7 items-center gap-2 pointer-coarse:min-h-11 ${state.busy ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          data-new-ephemeral-toggle
          className="peer sr-only"
          checked={checked}
          disabled={state.busy}
          aria-describedby={checked ? 'new-ephemeral-hint' : undefined}
          onChange={(event) => { state.setEphemeral(event.target.checked); }}
        />
        <span
          aria-hidden
          className={`relative inline-flex h-[14px] w-[24px] shrink-0 items-center rounded-full ring-1 transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
            checked ? 'bg-accent-soft ring-accent/45' : 'bg-hairline ring-hairline-strong'
          }`}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full transition-transform duration-150 motion-reduce:transition-none ${
              checked ? 'translate-x-[13px] bg-accent' : 'translate-x-[3px] bg-ink-faint'
            }`}
          />
        </span>
        <span className={`text-[12px] leading-4 ${state.busy ? 'text-ink-faint' : checked ? 'text-ink' : 'text-ink-soft'}`}>
          {t('ephemeral.newToggle')}
        </span>
      </label>
      {checked ? (
        <p id="new-ephemeral-hint" data-new-ephemeral-hint className="anim-enter min-w-0 pl-8 text-[12px] leading-4 text-ink-soft">
          {t('ephemeral.newHint')}
        </p>
      ) : null}
    </div>
  );
}
