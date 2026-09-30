/**
 * Small settings controls shared between the settings page and the provider
 * editor components: inline feedback lines, the switch Toggle, and Hint.
 */

import { useI18n } from '../i18n';
import { Icon } from './icons';

export type Feedback = { tone: 'success' | 'error' | 'info'; text: string } | null;

/**
 * Inline result of an action, in the reading font: one quiet line with a drawn
 * mark, never a boxed banner. Success and info stay in the ink scale so a saved
 * card does not shout; only an error takes the danger color.
 */
export function FeedbackLine({ feedback }: { feedback: Feedback }) {
  if (feedback === null) return null;
  const tone =
    feedback.tone === 'error' ? 'text-danger'
      : feedback.tone === 'success' ? 'text-ink-soft'
        : 'text-ink-faint';
  const mark = feedback.tone === 'error' ? 'warning' : feedback.tone === 'success' ? 'check' : null;
  return (
    <p
      role={feedback.tone === 'error' ? 'alert' : 'status'}
      data-feedback-tone={feedback.tone}
      className={`anim-enter flex max-w-[72ch] items-start gap-1.5 text-[12px] leading-[18px] ${tone}`}
    >
      {mark !== null ? (
        <Icon name={mark} size={12} className={`mt-[3px] ${feedback.tone === 'success' ? 'text-success' : ''}`} />
      ) : null}
      <span className="min-w-0 break-words">{feedback.text}</span>
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
  id,
  label,
  checked,
  onChange,
  disabled = false,
  layout = 'inline',
}: {
  id?: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /**
   * `row`: label on the left, switch on the right edge (settings rows).
   * `bare`: the switch alone, for the control slot of a `SettingField` that
   * already prints the label; the label stays for assistive tech only.
   */
  layout?: 'inline' | 'row' | 'bare';
}) {
  const text = <span className={layout === 'bare' ? 'sr-only' : 'text-[13px] text-ink'}>{label}</span>;
  // Quiet switch: a tinted track with a solid knob. ON is a choice you made,
  // not something waiting on you, so it takes the ink-blue "selected" role
  // and a column of switches never reads as a row of alerts. The real
  // checkbox sits first so the track can show its keyboard focus.
  return (
    <label className={`${layout === 'row' ? 'flex w-full justify-between' : 'inline-flex'} min-h-7 items-center gap-2.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
      {layout === 'row' ? text : null}
      <input
        id={id}
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
        className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full ring-1 transition-colors duration-150 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-selected-ink ${
          checked ? 'bg-selected ring-selected-ink/45' : 'bg-hairline ring-hairline-strong'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full transition-transform duration-150 motion-reduce:transition-none ${
            checked ? 'translate-x-[16px] bg-selected-ink' : 'translate-x-[3px] bg-ink-faint'
          }`}
        />
      </span>
      {layout === 'row' ? null : text}
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
    <span role="status" data-saved-tick className="anim-enter inline-flex items-center gap-1 text-[12px] font-medium text-success">
      <Icon name="check" size={12} />
      {t('st.savedTick')}
    </span>
  );
}

/**
 * The one inline save state for an instant-apply control: "Saving…" while the
 * write is in flight, then the transient ✓ Saved. Errors are not shown here;
 * they get their own `FeedbackLine` under the field, where there is room.
 */
export function SaveStatus({ saving, saved }: { saving: boolean; saved: boolean }) {
  const { t } = useI18n();
  if (saving) {
    return <span role="status" data-save-status="saving" className="text-[12px] text-ink-faint">{t('common.saving')}</span>;
  }
  return <SavedTick show={saved} />;
}
