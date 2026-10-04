import { useId } from 'react';

import { INPUT } from '../ui';
import { FORM_LABEL } from './SettingsPrimitives';
import { SettingHelp } from './SettingHelp';

/**
 * Numeric text field shared by the engine-config cards split off the runtime
 * leaf. `hint` says what the number does and is described-by, not part of the
 * label, so the input keeps a short accessible name.
 *
 * `detail` is the fine print a reader asks for rather than reads first: what
 * `0` means, what an empty field resolves to, what the engine default is. It
 * renders behind the label's `i` and is the only thing that reaches the
 * accessible description while it is open, so a page can show what matters at
 * a glance without repeating the same "empty means the default" line under
 * every number.
 */
export function NumberField({ label, value, onChange, placeholder, hint, detail }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: React.ReactNode;
  /** Read on demand, behind the label's `i`; never part of the first screen. */
  detail?: React.ReactNode;
}) {
  const inputId = useId();
  const hintId = useId();
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <label htmlFor={inputId} className={FORM_LABEL}>
          {label}
        </label>
        {detail !== undefined && detail !== null ? <SettingHelp>{detail}</SettingHelp> : null}
      </div>
      <input
        id={inputId}
        className={`${INPUT} mt-1 font-mono font-normal`}
        inputMode="numeric"
        value={value}
        placeholder={placeholder}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => { onChange(event.target.value); }}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="mt-1 max-w-[62ch] text-[12px] font-normal leading-snug text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

/** One settings cluster: a quiet heading plus a one-line "what it affects". */
export function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-hairline pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[12px] font-semibold text-ink">{title}</h3>
        {hint !== undefined ? <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
