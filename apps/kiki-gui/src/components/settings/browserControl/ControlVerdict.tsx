/**
 * The lead line of the browser and computer settings tabs: one sentence that
 * says whether the configuration lets the Agent reach the capability, the one
 * action that fixes the first gate, and the capability's own switch.
 *
 * The tone colours only the dot. `unknown` is drawn like a pending read, never
 * like success, and `off` reads quieter than a problem because it is a choice.
 */

import type { ReactNode } from 'react';

import type { ControlVerdictTone } from '@kiki/session-core/settings';

import { SaveStatus } from '../../controls';

const DOT: Readonly<Record<ControlVerdictTone, string>> = {
  ok: 'bg-success',
  attention: 'bg-amber-rule',
  off: 'bg-hairline-strong',
  unknown: 'bg-ink-faint',
};

export function ControlVerdictLine({ kind, tone, text, detail, action, attr }: {
  readonly kind: string;
  readonly tone: ControlVerdictTone;
  readonly text: string;
  /** A quieter second fact on the same line (the default, the platform). */
  readonly detail?: string;
  readonly action?: ReactNode;
  /** The data attribute the line carries, e.g. `data-browser-verdict`. */
  readonly attr: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <p role="status" className="flex min-w-0 items-baseline gap-2 text-[13px] leading-5" {...{ [attr]: kind, 'data-verdict-tone': tone }}>
        <span aria-hidden className={`relative top-[-1px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className={tone === 'off' ? 'text-ink-soft' : 'text-ink'}>
          {text}
          {detail === undefined ? null : <span className="text-ink-soft">{` · ${detail}`}</span>}
        </span>
      </p>
      {action}
    </div>
  );
}

/** The capability's own on/off switch, labelled, with the save tick beside it. */
export function CapabilitySwitch({ id, label, checked, disabled, saving, saved, onChange, attr }: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly saved: boolean;
  readonly onChange: (next: boolean) => void;
  readonly attr: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <SaveStatus saving={saving} saved={saved} />
      <label htmlFor={id} className={`text-[12px] ${disabled ? 'text-ink-faint' : 'cursor-pointer text-ink-soft'}`}>{label}</label>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        {...{ [attr]: '' }}
        onClick={() => { onChange(!checked); }}
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-[var(--kiki-motion-quick)] ${
          checked ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
        } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${
            checked ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
          }`}
        />
      </button>
    </div>
  );
}
