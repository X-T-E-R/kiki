/**
 * CompactPointField — one "automatic compaction point" input for layers that
 * store an absolute token count (model, profile). Accepts `400k` / `400000`,
 * and `73%` when a window is known to convert against; the stored value is
 * always an integer. Empty means "not set here": the placeholder names the
 * value that applies instead and where it comes from.
 */

import { useEffect, useId, useState } from 'react';

import { useI18n } from '../../i18n';
import { compactInputTokens, formatCompactTokens, parseCompactInput } from '../../lib/autoCompact';
import { TokenPresetRow } from '../TokenPresetRow';
import { SMALL_INPUT } from '../ui';

export function CompactPointField({
  label,
  value,
  onChange,
  windowTokens,
  placeholder,
  hint,
  dataAttribute,
  labelClassName = 'block text-[12px] font-medium text-ink-soft',
  presets,
  presetsLabel,
  disabled = false,
}: {
  /** Match the surrounding form's label style. */
  labelClassName?: string;
  /** One-click token values beside the input (already filtered to the model). */
  presets?: readonly number[];
  presetsLabel?: string;
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  /** Base for `%` input; percent entry is refused without one. */
  windowTokens?: number;
  placeholder: string;
  hint?: string;
  dataAttribute?: string;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const errorId = useId();
  const [text, setText] = useState(value === undefined ? '' : formatCompactTokens(value));
  const [error, setError] = useState(false);

  useEffect(() => {
    setText(value === undefined ? '' : formatCompactTokens(value));
    setError(false);
  }, [value]);

  const commit = () => {
    if (text.trim() === '') {
      setError(false);
      if (value !== undefined) onChange(undefined);
      return;
    }
    const parsed = parseCompactInput(text);
    const tokens = compactInputTokens(parsed, windowTokens ?? 0);
    if (tokens === null) {
      setError(true);
      return;
    }
    setError(false);
    setText(formatCompactTokens(tokens));
    if (tokens !== value) onChange(tokens);
  };

  return (
    <div className="space-y-1" data-compact-point-field={dataAttribute}>
      <label htmlFor={id} className={labelClassName}>{label}</label>
      <input
        id={id}
        inputMode="decimal"
        spellCheck={false}
        autoComplete="off"
        disabled={disabled}
        className={`${SMALL_INPUT} h-8 w-full max-w-[18rem] font-mono tabular-nums ${error ? 'border-danger' : ''}`}
        value={text}
        placeholder={placeholder}
        aria-invalid={error}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => { setText(event.target.value); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      />
      {presets !== undefined && presets.length > 0 ? (
        <div className="-ml-2">
          <TokenPresetRow
            dataAttribute={dataAttribute}
            label={presetsLabel ?? label}
            values={presets}
            current={value}
            disabled={disabled}
            onPick={(next) => { setError(false); onChange(next === value ? undefined : next); }}
          />
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] text-danger">{t('st.compact.inputInvalid')}</p>
      ) : hint !== undefined ? (
        <p className="max-w-[62ch] text-[12px] leading-snug text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}
