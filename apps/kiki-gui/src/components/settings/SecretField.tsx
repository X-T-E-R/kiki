/**
 * One secret, one shape, everywhere in settings: masked by default, revealed
 * on the eye (fetched on demand, never prefetched), copy, edit and clear, with
 * a quiet line under the control saying where the value comes from.
 *
 * The field is controlled over a `SecretDraft` so each section keeps its own
 * save flow: `keep` leaves the stored value alone, `set` writes a new one,
 * `clear` removes the value saved in Kiki. An environment-sourced value is
 * still viewable, and editing it saves a Kiki value that overrides it.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SecretSource } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { Icon } from '../icons';
import { SECONDARY_BUTTON } from '../ui';

export type SecretDraft =
  | { readonly mode: 'keep' }
  | { readonly mode: 'set'; readonly value: string }
  | { readonly mode: 'clear' };

export const KEEP_SECRET: SecretDraft = { mode: 'keep' };

/** Fixed width so the mask never hints at the length of the value. */
const MASK = '••••••••••••••••';

const ICON_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors duration-[var(--kiki-motion-quick)] hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11';
const TEXT_BUTTON = `${SECONDARY_BUTTON} min-h-8 pointer-coarse:min-h-11`;

export interface SecretFieldProps {
  readonly label: string;
  /** Where the value currently in effect comes from. */
  readonly source: SecretSource;
  /** Variable name for `environment` / `local` sources. */
  readonly envName?: string;
  readonly draft: SecretDraft;
  readonly onChange: (draft: SecretDraft) => void;
  /** Fetches the effective value on explicit request. Absent when nothing is stored yet. */
  readonly reveal?: () => Promise<string | undefined>;
  /** Clearing only removes a Kiki-saved value; defaults to `source === 'kiki'`. */
  readonly clearable?: boolean;
  /** Replaces the source line, for values that live outside the server (a browser token). */
  readonly sourceText?: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly hint?: ReactNode;
  readonly id?: string;
  /** Hides the visible label when an outer row already names the value. */
  readonly labelHidden?: boolean;
  /** View and copy only: the value is owned elsewhere and cannot be edited here. */
  readonly readOnlyValue?: boolean;
}

export function SecretField({
  label, source, envName, draft, onChange, reveal, clearable, sourceText,
  disabled = false, placeholder, hint, id, labelHidden = false, readOnlyValue = false,
}: SecretFieldProps) {
  const { t } = useI18n();
  const generated = useId();
  const inputId = id ?? `${generated}-secret`;
  const statusId = `${inputId}-status`;
  const [revealed, setRevealed] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'reveal' | 'copy' | null>(null);
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasStored = source !== 'none' && reveal !== undefined;
  const canClear = (clearable ?? source === 'kiki') && hasStored;
  const editing = !readOnlyValue && (draft.mode === 'set' || (draft.mode === 'keep' && !hasStored));

  // A new source or a finished save makes any revealed copy stale.
  useEffect(() => {
    request.current++;
    setRevealed(null);
    setVisible(false);
    setBusy(false);
    setError(null);
  }, [source, envName, reveal]);
  useEffect(() => {
    if (draft.mode === 'keep') { setRevealed(null); setVisible(false); }
  }, [draft.mode]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => { setCopied(false); }, 1600);
    return () => { clearTimeout(timer); };
  }, [copied]);

  const fetchValue = async (): Promise<string | undefined> => {
    if (revealed !== null) return revealed;
    if (reveal === undefined) return undefined;
    const revision = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const value = await reveal();
      if (request.current !== revision) return undefined;
      if (value === undefined) { setError('reveal'); return undefined; }
      setRevealed(value);
      return value;
    } catch {
      if (request.current === revision) setError('reveal');
      return undefined;
    } finally {
      if (request.current === revision) setBusy(false);
    }
  };

  const toggleVisible = async () => {
    if (visible) { setVisible(false); return; }
    if (editing) { setVisible(true); return; }
    if (await fetchValue() !== undefined) setVisible(true);
  };

  const copy = async () => {
    const value = draft.mode === 'set' ? draft.value : await fetchValue();
    if (value === undefined || value === '') return;
    try {
      await copyTextToClipboard(value);
      setError(null);
      setCopied(true);
    } catch {
      setError('copy');
    }
  };

  const startEdit = () => {
    onChange({ mode: 'set', value: revealed ?? '' });
    requestAnimationFrame(() => { inputRef.current?.focus(); });
  };

  const draftValue = draft.mode === 'set' ? draft.value : '';
  const shownValue = draft.mode === 'clear' ? ''
    : editing ? draftValue
      : visible && revealed !== null ? revealed : MASK;
  const inputType = editing && !visible ? 'password' : 'text';
  const overrides = draft.mode === 'set' && draft.value !== '' && (source === 'environment' || source === 'local');
  const sourceLine = sourceText ?? secretSourceText(t, source, envName);
  const copyDisabled = disabled || busy || draft.mode === 'clear' || (editing ? draftValue === '' : !hasStored);
  const eyeDisabled = disabled || busy || draft.mode === 'clear' || (editing ? draftValue === '' : !hasStored);

  return (
    <div className="min-w-0 space-y-1.5" data-secret-field data-secret-source={source} data-secret-mode={draft.mode}>
      <label htmlFor={inputId} className={labelHidden ? 'sr-only' : 'block text-[13px] font-medium text-ink'}>{label}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className={`flex min-w-0 flex-[1_1_16rem] items-center rounded-lg border bg-paper transition-colors focus-within:border-accent ${
          draft.mode === 'clear' ? 'border-dashed border-hairline-strong' : 'border-hairline'} ${disabled ? 'bg-hairline/20' : ''}`}>
          <input
            ref={inputRef}
            id={inputId}
            type={inputType}
            value={shownValue}
            readOnly={!editing}
            disabled={disabled || draft.mode === 'clear'}
            placeholder={draft.mode === 'clear' ? t('st.secret.clearPending')
              : placeholder ?? t(hasStored ? 'st.secret.editPlaceholder' : 'st.secret.newPlaceholder')}
            aria-describedby={statusId}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            className={`min-w-0 flex-1 bg-transparent px-2.5 py-2 font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-ink-faint disabled:cursor-not-allowed ${
              !editing && !visible ? 'tracking-[0.12em] text-ink-soft' : 'text-ink'}`}
            onChange={(event) => {
              const value = event.target.value;
              onChange(value === '' && !hasStored ? KEEP_SECRET : { mode: 'set', value });
            }}
          />
          <button type="button" className={ICON_BUTTON} disabled={eyeDisabled} aria-pressed={visible}
            aria-label={t(visible ? 'st.secret.hideLabel' : 'st.secret.showLabel', { label })}
            title={t(visible ? 'st.secret.hideLabel' : 'st.secret.showLabel', { label })}
            data-secret-reveal onClick={() => void toggleVisible()}>
            {busy ? <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" />
              : <Icon name={visible ? 'eyeOff' : 'eye'} />}
          </button>
          <button type="button" className={`${ICON_BUTTON} me-0.5`} disabled={copyDisabled}
            aria-label={t('st.secret.copyLabel', { label })} title={t('st.secret.copyLabel', { label })}
            data-secret-copy onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-success' : ''} />
          </button>
        </div>
        {draft.mode === 'clear' ? (
          <button type="button" className={TEXT_BUTTON} disabled={disabled} data-secret-undo onClick={() => { onChange(KEEP_SECRET); }}>
            {t('st.secret.undoClear')}
          </button>
        ) : draft.mode === 'set' && hasStored ? (
          <button type="button" className={TEXT_BUTTON} disabled={disabled} data-secret-cancel onClick={() => { onChange(KEEP_SECRET); }}>
            {t('common.cancel')}
          </button>
        ) : hasStored && !readOnlyValue ? (
          <>
            <button type="button" className={TEXT_BUTTON} disabled={disabled} data-secret-edit onClick={startEdit}>
              {t(source === 'kiki' ? 'st.secret.edit' : 'st.secret.override')}
            </button>
            {canClear ? (
              <button type="button" className={TEXT_BUTTON} disabled={disabled} data-secret-clear onClick={() => { onChange({ mode: 'clear' }); }}>
                {t('st.secret.clear')}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <p id={statusId} aria-live="polite" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] leading-snug">
        <span className={`inline-flex items-center gap-1.5 ${source === 'none' ? 'text-ink-faint' : 'text-ink-soft'}`}>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${sourceDot(source)}`} />
          <SourceText text={sourceLine} name={envName} />
        </span>
        {draft.mode === 'clear' ? <span className="text-amber-ink">· {t('st.secret.clearPending')}</span> : null}
        {overrides ? <span className="text-accent-ink">· {t('st.secret.overrideHint')}</span> : null}
        {copied ? <span className="text-success">· {t('st.secret.copied')}</span> : null}
        {error !== null ? <span role="alert" className="text-danger">· {t(error === 'reveal' ? 'st.secret.revealError' : 'st.secret.copyError')}</span> : null}
      </p>
      {hint !== undefined && hint !== null ? <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">{hint}</p> : null}
    </div>
  );
}

/** Env names render in mono inside the sentence so they read as identifiers. */
function SourceText({ text, name }: { text: string; name?: string }) {
  if (name === undefined || !text.includes(name)) return <span>{text}</span>;
  const [before, ...rest] = text.split(name);
  return <span>{before}<code className="font-mono text-[11.5px] text-ink">{name}</code>{rest.join(name)}</span>;
}

function sourceDot(source: SecretSource): string {
  return source === 'kiki' ? 'bg-accent' : source === 'none' ? 'bg-hairline-strong' : 'bg-amber-rule';
}

export function secretSourceText(
  t: ReturnType<typeof useI18n>['t'],
  source: SecretSource,
  envName?: string,
): string {
  if (source === 'environment') {
    return envName === undefined ? t('st.secret.source.environmentAny') : t('st.secret.source.environment', { name: envName });
  }
  if (source === 'local') return t('st.secret.source.local');
  return t(source === 'kiki' ? 'st.secret.source.kiki' : 'st.secret.source.none');
}
