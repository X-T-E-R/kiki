import { useEffect, useId, useRef, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { cleanFontName, detectFont, firstFamily, fontStack, type FontPresence } from '../../lib/fontDetect';
import { SettingField } from './fields';
import { SettingsSelect } from './SettingsPrimitives';

/** Picker value for "type a family name". Not a valid stack, so it never collides. */
export const CUSTOM_FONT = '__custom';

export interface FontPreset {
  readonly value: string;
  readonly label: string;
}

const SAMPLE_CLASS = {
  sans: 'text-[14px] leading-6',
  mono: 'font-mono text-[13px] leading-6',
  prose: 'text-[15.5px] leading-7',
} as const;

const SAMPLE_KEY: Record<keyof typeof SAMPLE_CLASS, I18nKey> = {
  sans: 'st.font.sample.sans',
  mono: 'st.font.sample.mono',
  prose: 'st.font.sample.prose',
};

/**
 * One typeface role (interface, replies, code): the presets, plus a typed
 * family name that applies as you type. A typed name leads its own stack, so
 * glyphs it lacks (Chinese, say) still land on the role's deliberate
 * fallbacks. Under the field, a sample line in the chosen face and whether
 * the face is on this machine.
 */
export function FontRoleField({ role, label, help, presets, presetValue, custom, fallback, onPreset, onCustom }: {
  role: keyof typeof SAMPLE_CLASS;
  label: string;
  help?: string;
  presets: readonly FontPreset[];
  /** The preset currently in force (used when no family is typed). */
  presetValue: string;
  /** The stored custom stack, if any. */
  custom: string | undefined;
  /** The role's own fallback stack, appended after a typed family. */
  fallback: string;
  onPreset: (value: string) => void;
  onCustom: (stack: string | undefined) => void;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const [editing, setEditing] = useState(custom !== undefined);
  const [draft, setDraft] = useState(() => (custom === undefined ? '' : firstFamily(custom)));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Another writer (Restore defaults, its undo, another window) moved the
  // stored family: follow it, and leave the field once it is cleared. An
  // empty field the user is still typing into stays open.
  useEffect(() => {
    if (custom !== undefined) {
      setEditing(true);
      if (firstFamily(custom) !== draftRef.current.trim()) setDraft(firstFamily(custom));
    } else if (draftRef.current.trim() !== '') {
      setEditing(false);
      setDraft('');
    }
  }, [custom]);

  const showCustom = editing || custom !== undefined;
  const name = draft.trim();
  const presence: FontPresence = name === '' ? 'unknown' : detectFont(name);

  const choose = (value: string) => {
    if (value === CUSTOM_FONT) {
      setEditing(true);
      if (name !== '') onCustom(fontStack(name, fallback));
      return;
    }
    setEditing(false);
    setDraft('');
    onCustom(undefined);
    onPreset(value);
  };

  const type = (raw: string) => {
    const next = cleanFontName(raw);
    setDraft(next);
    onCustom(next.trim() === '' ? undefined : fontStack(next, fallback));
  };

  return (
    <div data-font-role={role}>
      <SettingField label={label} help={help}>
        <SettingsSelect
          ariaLabel={label}
          dataAttr="data-font-choice"
          value={showCustom ? CUSTOM_FONT : presetValue}
          onChange={choose}
          choices={[...presets, { value: CUSTOM_FONT, label: t('st.font.custom') }]}
        />
      </SettingField>
      {showCustom ? (
        <div className="mb-2 space-y-2 rounded-lg bg-ink/[0.03] p-3 sm:ml-auto sm:max-w-[26rem]" data-font-custom>
          <label htmlFor={inputId} className="block text-[12px] text-ink-soft">{t('st.font.nameLabel')}</label>
          <input
            id={inputId}
            type="text"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            // Typing is the choice: it applies at once, like every control here.
            onChange={(event) => { type(event.target.value); }}
            placeholder={t(role === 'mono' ? 'st.font.placeholderMono' : 'st.font.placeholder')}
            className="h-8 w-full rounded-md border border-hairline bg-paper px-3 text-[13px] text-ink outline-none transition-colors duration-[var(--kiki-motion-quick)] placeholder:text-ink-faint focus:border-selected-ink"
          />
          <p
            data-font-sample
            className={`truncate text-ink ${SAMPLE_CLASS[role]}`}
            style={name === '' ? undefined : { fontFamily: fontStack(name, fallback) }}
          >
            {t(SAMPLE_KEY[role])}
          </p>
          <p aria-live="polite" data-font-presence={presence} className={`text-[12px] leading-4 ${presence === 'missing' ? 'text-amber-ink' : 'text-ink-faint'}`}>
            {presence === 'missing'
              ? t('st.font.missing', { name })
              : presence === 'present'
                ? t('st.font.present', { name })
                : t('st.font.typeHint')}
          </p>
        </div>
      ) : null}
    </div>
  );
}
