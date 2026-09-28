import { useMemo, useState } from 'react';

import { useI18n } from '../i18n';
import {
  API_PROTOCOLS,
  PROVIDER_PRESETS,
  presetById,
  protocolLabel,
  type ProviderPreset,
  type ProviderWireType,
} from './providerPresets';
import { INPUT } from './ui';

const SHORTCUT_IDS = ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot'] as const;
const TILE =
  'group flex min-w-0 rounded-lg border border-hairline bg-paper px-3 py-2.5 text-left transition-colors hover:border-hairline-strong hover:bg-panel focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30';

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, '');
}

export function PresetGrid({
  onPick,
  dense = false,
}: {
  onPick: (preset: ProviderPreset | null, protocol?: ProviderWireType) => void;
  /** Onboarding uses the same protocol and search paths without shortcut chips. */
  dense?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const needle = normalize(query.trim());
  const matches = useMemo(
    () => needle === '' ? [] : PROVIDER_PRESETS.filter((preset) =>
      normalize(preset.id).includes(needle)
      || normalize(preset.label).includes(needle)
      || normalize(preset.baseUrl).includes(needle)),
    [needle],
  );
  const shortcuts = SHORTCUT_IDS.flatMap((id) => {
    const preset = presetById(id);
    return preset === undefined ? [] : [preset];
  });

  return (
    <div className="space-y-3" data-preset-grid>
      <input
        type="search"
        className={INPUT}
        aria-label={t('st.presets.searchAria')}
        placeholder={t('st.presets.searchPlaceholder')}
        value={query}
        onChange={(event) => { setQuery(event.target.value); }}
      />
      {matches.length > 0 ? (
        <section aria-label={t('st.presets.matches')} data-preset-results>
          <p className="mb-1.5 text-[12px] font-medium text-ink-soft">{t('st.presets.matches')}</p>
          <div className={`grid grid-cols-2 gap-2 ${dense ? 'sm:grid-cols-3' : 'sm:grid-cols-3 lg:grid-cols-4'}`}>
            {matches.map((preset) => (
              <button key={preset.id} type="button" data-provider-template={preset.id}
                onClick={() => { onPick(preset); }} className={`${TILE} flex-col gap-0.5`}>
                <span className="truncate text-[13px] font-medium text-ink">{preset.label}</span>
                <span className="truncate text-[11px] text-ink-faint">{protocolLabel(preset.type)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          {needle !== '' ? <p className="text-[12px] text-ink-faint">{t('st.presets.empty', { query: query.trim() })}</p> : null}
          <section aria-label={t('st.presets.protocols')} className="@container">
            <p className="mb-1.5 text-[12px] font-medium text-ink-soft">{t('st.presets.protocols')}</p>
            <div className={dense ? 'flex flex-col gap-2' : 'grid grid-cols-1 gap-2 @min-[720px]:grid-cols-5'}>
              {API_PROTOCOLS.map((type) => (
                <button key={type} type="button" data-provider-protocol={type}
                  onClick={() => { onPick(null, type); }}
                  className={`${TILE} items-center justify-between gap-3 ${dense ? '' : '@min-[720px]:flex-col @min-[720px]:items-start @min-[720px]:justify-center @min-[720px]:gap-0.5'}`}>
                  <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-ink" title={protocolLabel(type)}>{protocolLabel(type)}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">{type}</span>
                </button>
              ))}
            </div>
          </section>
          {!dense && needle === '' ? (
            <section aria-label={t('st.presets.shortcuts')}>
              <p className="mb-1.5 text-[12px] font-medium text-ink-soft">{t('st.presets.shortcuts')}</p>
              <div className="flex flex-wrap gap-1.5">
                {shortcuts.map((preset) => (
                  <button key={preset.id} type="button" data-provider-template={preset.id}
                    onClick={() => { onPick(preset); }}
                    className="rounded-full border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
                    {preset.label}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
