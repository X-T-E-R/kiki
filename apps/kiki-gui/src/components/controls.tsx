/**
 * Small settings controls shared between the settings page and the provider
 * editor components: inline feedback lines, the switch Toggle, and Hint.
 */

import { useI18n } from '../i18n';
import { Icon } from './icons';

export type Feedback = { tone: 'success' | 'error' | 'info'; text: string } | null;

export function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (feedback === null) return null;
  const classes =
    feedback.tone === 'error'
      ? 'border-danger/30 bg-danger/5 text-danger'
      : feedback.tone === 'success'
        ? 'border-success/30 bg-success/5 text-success'
        : 'border-hairline bg-paper text-ink-soft';
  return (
    <p role={feedback.tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-2.5 py-2 font-mono text-[11px] ${classes}`}>
      {feedback.text}
    </p>
  );
}

export function InlineError({ error }: { error: unknown }) {
  return (
    <FeedbackLine
      feedback={{
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      }}
    />
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
  layout = 'inline',
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** `row`: label on the left, switch on the right edge (settings rows). */
  layout?: 'inline' | 'row';
}) {
  const text = <span className="text-[13px] text-ink">{label}</span>;
  // Quiet switch: a tinted track with a solid knob. Only the ON knob carries
  // the accent, so a column of switches reads as state, not as a row of
  // orange buttons. The real checkbox sits first so the track can show its
  // keyboard focus.
  return (
    <label className={`${layout === 'row' ? 'flex w-full justify-between' : 'inline-flex'} min-h-7 items-center gap-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      {layout === 'row' ? text : null}
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.checked); }}
      />
      <span
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
          checked ? 'bg-accent-soft ring-accent/45' : 'bg-hairline ring-hairline-strong'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-150 motion-reduce:transition-none ${
            checked ? 'translate-x-[16px] bg-accent' : 'translate-x-[3px] bg-ink-faint'
          }`}
        />
      </span>
      {layout === 'inline' ? text : null}
    </label>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">{children}</p>;
}

/** Transient "Saved" affirmation for instant-apply controls; the check is drawn, not typed. */
export function SavedTick({ show }: { show: boolean }) {
  const { t } = useI18n();
  if (!show) return null;
  return (
    <span role="status" className="anim-enter inline-flex items-center gap-1 text-[12px] font-medium text-success">
      <Icon name="check" size={12} />
      {t('st.savedTick')}
    </span>
  );
}
