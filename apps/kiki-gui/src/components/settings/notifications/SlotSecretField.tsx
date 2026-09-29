import { useCallback, useState } from 'react';

import { useI18n } from '../../../i18n';
import { KEEP_SECRET, SecretField, type SecretDraft } from '../SecretField';

/**
 * One credential slot on the shared secret field, instant apply: a typed
 * value commits when focus leaves the field or on Enter, Clear commits at
 * once. Values are write-only on the wire; the eye reveals through
 * `/secrets:reveal` only on request.
 */
export function SlotSecretField({ label, configured, optional, disabled, reveal, onCommit }: {
  label: string;
  configured: boolean;
  optional: boolean;
  disabled: boolean;
  reveal: () => Promise<string | undefined>;
  /** `null` clears the stored value. Resolves true when the write landed. */
  onCommit: (value: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<SecretDraft>(KEEP_SECRET);
  const [busy, setBusy] = useState(false);

  const commit = useCallback(async (next: SecretDraft) => {
    if (next.mode === 'keep') return;
    const value = next.mode === 'clear' ? null : next.value.trim();
    if (value === '') return;
    setBusy(true);
    const ok = await onCommit(value);
    setBusy(false);
    if (ok) setDraft(KEEP_SECRET);
  }, [onCommit]);

  return (
    <div
      data-notify-secret={label}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        if (draft.mode === 'set') void commit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && draft.mode === 'set') { event.preventDefault(); void commit(draft); }
        if (event.key === 'Escape' && draft.mode === 'set') setDraft(KEEP_SECRET);
      }}
    >
      <SecretField
        label={optional ? `${label} · ${t('st.notify.optional')}` : label}
        source={configured ? 'kiki' : 'none'}
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          if (next.mode === 'clear') void commit(next);
        }}
        reveal={configured ? reveal : undefined}
        clearable={configured}
        disabled={disabled || busy}
      />
    </div>
  );
}
