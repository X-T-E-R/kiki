/**
 * Small settings controls shared between the settings page and the provider
 * editor components: inline feedback lines, the switch Toggle, and Hint.
 */

import { useI18n } from '../i18n';

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
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      <span
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-hairline-strong'
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-1'
          }`}
        />
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.checked); }}
      />
      <span className="text-[12.5px] text-ink-soft">{label}</span>
    </label>
  );
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] leading-relaxed text-ink-faint">{children}</p>;
}

/** Transient "✓ Saved" affirmation for instant-apply controls. */
export function SavedTick({ show }: { show: boolean }) {
  const { t } = useI18n();
  if (!show) return null;
  return (
    <span role="status" className="anim-enter text-[11px] font-medium text-success">
      {t('st.savedTick')}
    </span>
  );
}
