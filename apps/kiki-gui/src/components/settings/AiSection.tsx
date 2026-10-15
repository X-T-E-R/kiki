import { useLocation } from 'react-router-dom';

import {
  AI_SETTINGS_DEFAULT_TAB,
  AI_SETTINGS_TABS,
  aiTabLabelKey,
  normalizeAiTab,
  type AiSettingsTab,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultModelBar } from './DefaultModelBar';
import { DefaultsTab, ModelsTab } from './ModelsSection';
import { ConnectionsTab } from './ProvidersSection';

/**
 * Visual tab order follows the path a person takes: connect something, see
 * the models it brings, then decide which model each job uses. Tab ids and
 * deep links are unchanged.
 */
const AI_TAB_ORDER: readonly AiSettingsTab[] = (['providers', 'models', 'defaults'] as const)
  .filter((candidate) => (AI_SETTINGS_TABS as readonly string[]).includes(candidate));

/**
 * The merged "Models & providers" entry (settings redesign batch 2, §3.3 /
 * §7.1): one navigation leaf, three stable tabs — Connections (OAuth, API
 * keys, provider lifecycle), Available models (cross-provider catalog), and
 * Defaults (per-job models, request identity, thinking). The new-session
 * default model is a bar above all three, so it is stated once and reachable
 * from wherever the reader lands. The active tab is the `?tab=` query so deep
 * links, search hits, and the legacy `/settings/models` / `/settings/providers`
 * redirects all land on the right one; unknown values fall back to the default tab.
 */
export function AiSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  const tab = normalizeAiTab(new URLSearchParams(search).get('tab')) ?? AI_SETTINGS_DEFAULT_TAB;

  // Tab switches go through the guarded navigator: an unsaved provider draft
  // on the Connections tab arms the same leave-guard as a section switch.
  const selectTab = (next: AiSettingsTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    navigate(`/settings/ai?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <DefaultModelBar tab={tab} />
      <div role="tablist" aria-label={t('st.section.ai')} className="flex gap-1 border-b border-hairline">
        {AI_TAB_ORDER.map((candidate) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={active}
              data-ai-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors ${
                active
                  ? 'border-ink font-medium text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(aiTabLabelKey(candidate))}
            </button>
          );
        })}
      </div>
      {tab === 'providers' ? <ConnectionsTab /> : tab === 'defaults' ? <DefaultsTab /> : <ModelsTab />}
    </div>
  );
}
