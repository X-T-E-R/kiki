/**
 * Fetch quality fallback: the minimum body length a fetched page must have
 * before it counts as content, and the markers that mark a page as a failure
 * page. Both replace the source value only when the user writes one — empty
 * means the source's value stays in force, and "no markers" is a different,
 * explicit state.
 *
 * Renders the body only — the Advanced tab owns the group heading.
 */

import { useState } from 'react';
import { useI18n } from '../../../i18n';
import { Icon } from '../../icons';
import { INPUT, SECONDARY_BUTTON } from '../../ui';
import { SettingsSegmented } from '../SettingsPrimitives';
import type { NbSearchAdvancedBinding } from './advancedSupport';

const MAX_MARKERS = 64;
const MAX_CONTENT_CHARS = 10_000_000;

export function NbSearchQualityEditor({
  binding,
  saving = false,
}: {
  binding: NbSearchAdvancedBinding;
  saving?: boolean;
}) {
  const { t } = useI18n();
  const advanced = binding.draft.advanced;
  const [markersText, setMarkersText] = useState('');
  const [adding, setAdding] = useState(false);

  if (advanced === undefined) return null;

  const own = advanced.qualityBlockedMarkers;
  const mode = own === undefined ? 'inherit' : 'custom';
  const trimmed = advanced.qualityMinContentChars.trim();
  const numeric = Number(trimmed);
  const invalid = trimmed !== '' && (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_CONTENT_CHARS);

  const writeMin = (qualityMinContentChars: string) => {
    binding.onChange({ ...binding.draft, advanced: { ...advanced, qualityMinContentChars } });
  };

  const writeMarkers = (markers: readonly string[] | undefined) => {
    binding.onChange({
      ...binding.draft,
      advanced: { ...advanced, qualityBlockedMarkers: markers === undefined ? undefined : [...markers] },
    });
  };

  const addMarker = (raw: string) => {
    const value = raw.trim();
    setMarkersText('');
    if (value === '' || value.length > 256) return;
    const current = own ?? [];
    if (current.includes(value) || current.length >= MAX_MARKERS) return;
    writeMarkers([...current, value]);
  };

  return (
    <div className="space-y-3">
      <label className="block text-[12px] font-medium text-ink-soft">
        {t('st.nbSearch.quality.minContentChars')}
        <input
          className={`${INPUT} mt-1 font-mono`}
          inputMode="numeric"
          value={advanced.qualityMinContentChars}
          disabled={saving}
          placeholder={t('st.nbSearch.advanced.valueInherited')}
          aria-label={t('st.nbSearch.quality.minContentChars')}
          data-nb-search-quality-min
          onChange={(event) => {
            writeMin(event.target.value);
          }}
        />
        {invalid ? (
          <p role="alert" data-nb-search-quality-issue className="mt-1 font-normal text-[12px] leading-4 text-danger">
            {t('st.nbSearch.invalidNumber', { value: trimmed })}
          </p>
        ) : (
          <span className="mt-1 block font-normal text-[12px] leading-snug text-ink-faint">
            {t('st.nbSearch.quality.minContentCharsHint')}
          </span>
        )}
      </label>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-ink-soft">{t('st.nbSearch.quality.markers')}</span>
          <SettingsSegmented
            value={mode}
            ariaLabel={t('st.nbSearch.quality.markers')}
            dataAttr="data-nb-search-quality-mode"
            disabled={saving}
            choices={[
              { value: 'inherit', label: t('st.nbSearch.advanced.inheritSource') },
              { value: 'custom', label: t('st.nbSearch.advanced.customValue') },
            ]}
            onChange={(next) => {
              if (next === 'inherit') writeMarkers(undefined);
              else if (own === undefined) writeMarkers([]);
            }}
          />
        </div>

        {mode === 'inherit' ? (
          <p className="text-[12px] leading-snug text-ink-faint" data-nb-search-quality-state="inherit">
            {t('st.nbSearch.quality.markersInherit')}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-hairline" data-nb-search-quality-markers>
              {(own ?? []).map((marker, index) => (
                <li key={`${index}:${marker}`} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-ink">{marker}</span>
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} shrink-0 px-1.5 py-1 text-danger hover:border-danger/40`}
                    aria-label={t('st.nbSearch.quality.removeMarker', { marker })}
                    title={t('st.nbSearch.quality.removeMarker', { marker })}
                    disabled={saving}
                    data-nb-search-quality-remove
                    onClick={() => {
                      writeMarkers((own ?? []).filter((_, candidate) => candidate !== index));
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>

            {(own ?? []).length === 0 ? (
              <p className="text-[12px] leading-snug text-ink-soft" data-nb-search-quality-state="none">
                {t('st.nbSearch.quality.markersNone')}
              </p>
            ) : null}

            {adding ? (
              <div className="flex items-center gap-2">
                <input
                  className={`${INPUT} font-mono`}
                  value={markersText}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t('st.nbSearch.quality.markerPlaceholder')}
                  aria-label={t('st.nbSearch.quality.addMarker')}
                  data-nb-search-quality-new
                  onChange={(event) => {
                    setMarkersText(event.target.value);
                  }}
                  onBlur={() => {
                    addMarker(markersText);
                    setAdding(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addMarker(markersText);
                      setAdding(false);
                    } else if (event.key === 'Escape') {
                      setMarkersText('');
                      setAdding(false);
                    }
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                className={`${SECONDARY_BUTTON} inline-flex items-center gap-1`}
                disabled={saving || (own ?? []).length >= MAX_MARKERS}
                data-nb-search-quality-add
                onClick={() => {
                  setAdding(true);
                }}
              >
                <Icon name="plus" size={12} />
                {t('st.nbSearch.quality.addMarker')}
              </button>
            )}

            <p className="text-[12px] leading-snug text-ink-faint">
              {t('st.nbSearch.quality.markersHint', { max: String(MAX_MARKERS) })}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
