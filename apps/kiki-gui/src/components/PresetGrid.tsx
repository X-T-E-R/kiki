import { useMemo, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../i18n';
import { Icon } from './icons';
import {
  API_PROTOCOLS,
  PROVIDER_PRESETS,
  hostLabel,
  presetById,
  protocolLabel,
  type ProviderPreset,
  type ProviderWireType,
} from './providerPresets';
import { INPUT } from './ui';

/** Vendor-neutral mix: two first-party APIs, a gateway, a local server. */
const SHORTCUT_IDS = ['openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'ollama'] as const;

/** Who speaks each protocol, so the choice is recognizable without vendor cards. */
const PROTOCOL_HINT_KEYS: Readonly<Record<string, I18nKey>> = {
  openai: 'st.presets.protocolHint.openai',
  openai_responses: 'st.presets.protocolHint.openai_responses',
  anthropic: 'st.presets.protocolHint.anthropic',
  'google-genai': 'st.presets.protocolHint.google-genai',
  vertexai: 'st.presets.protocolHint.vertexai',
};

const ROW =
  'group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-ink/[0.04] focus-visible:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 pointer-coarse:min-h-11';

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
          <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-paper">
            {matches.map((preset) => (
              <li key={preset.id}>
                <button type="button" data-provider-template={preset.id} onClick={() => { onPick(preset); }} className={ROW}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{preset.label}</span>
                    <span className="block truncate text-[12px] text-ink-faint">
                      {protocolLabel(preset.type)} · {hostLabel(preset.baseUrl)}
                    </span>
                  </span>
                  <Icon name="arrowRight" size={12} className="text-ink-faint group-hover:text-ink" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          {needle !== '' ? <p className="text-[12px] text-ink-faint">{t('st.presets.empty', { query: query.trim() })}</p> : null}
          <section aria-label={t('st.presets.protocols')}>
            <p className="mb-1.5 text-[12px] font-medium text-ink-soft">{t('st.presets.protocols')}</p>
            <ul className="divide-y divide-hairline overflow-hidden rounded-lg border border-hairline bg-paper">
              {API_PROTOCOLS.map((type) => {
                const hintKey = PROTOCOL_HINT_KEYS[type];
                return (
                  <li key={type}>
                    <button type="button" data-provider-protocol={type} onClick={() => { onPick(null, type); }} className={ROW}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink" title={protocolLabel(type)}>{protocolLabel(type)}</span>
                        {hintKey !== undefined ? (
                          <span className="block text-[12px] leading-4 text-ink-faint">{t(hintKey)}</span>
                        ) : null}
                      </span>
                      <span className="hidden shrink-0 font-mono text-[11px] text-ink-faint sm:inline">{type}</span>
                      <Icon name="arrowRight" size={12} className="text-ink-faint group-hover:text-ink" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          {!dense && needle === '' ? (
            <section aria-label={t('st.presets.shortcuts')} className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
              <span className="mr-1 text-[12px] text-ink-faint">{t('st.presets.shortcuts')}</span>
              {shortcuts.map((preset) => (
                <button key={preset.id} type="button" data-provider-template={preset.id}
                  onClick={() => { onPick(preset); }}
                  className="h-7 rounded-md px-2 text-[12px] text-ink-soft outline-none transition-colors hover:bg-ink/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 pointer-coarse:h-10">
                  {preset.label}
                </button>
              ))}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
