/**
 * The /new opt-in for a private conversation: saved on disk, excluded from
 * search, usage, and tool statistics. Auto-enabled when starting a draft for a
 * hidden persona unless the user explicitly toggles it on this draft.
 */

import { useI18n } from '../i18n';
import { Icon } from './icons';
import type { NewSessionDraftState } from './NewSessionDraft';

export function PrivateSessionOption({ state }: { readonly state: NewSessionDraftState }) {
  const { t } = useI18n();
  const checked = state.privateSession;
  return (
    <div data-new-private={checked || undefined} className="mt-2 flex min-w-0 flex-col items-start">
      <label className={`inline-flex min-h-7 items-center gap-2 pointer-coarse:min-h-11 ${state.busy ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          data-new-private-toggle
          className="peer sr-only"
          checked={checked}
          disabled={state.busy}
          aria-describedby={checked ? 'new-private-hint' : undefined}
          onChange={(event) => { state.setPrivateSession(event.target.checked); }}
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
          {t('private.newToggle')}
        </span>
      </label>
      {checked ? (
        <p id="new-private-hint" data-new-private-hint className="anim-enter min-w-0 pl-8 text-[12px] leading-4 text-ink-soft">
          {t('private.newHint')}
        </p>
      ) : null}
    </div>
  );
}

/** Quiet header indicator worn by a private conversation. */
export function PrivateMark({ className = '' }: { readonly className?: string }) {
  const { t } = useI18n();
  return (
    <span
      data-private-mark
      className={`inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] border border-hairline px-1.5 text-[11px] leading-none font-medium text-ink-soft ${className}`}
    >
      <Icon name="lock" size={12} className="text-ink-faint" />
      <span>{t('private.badge')}</span>
    </span>
  );
}
