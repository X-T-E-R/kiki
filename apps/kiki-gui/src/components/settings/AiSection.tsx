import { useLocation } from 'react-router-dom';
import { useSyncExternalStore } from 'react';

import {
  AI_SETTINGS_DEFAULT_TAB,
  AI_SETTINGS_TABS,
  aiTabLabelKey,
  normalizeAiTab,
  type AiSettingsTab,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { iaPrototypeModeSnapshot, subscribeIaPrototypeMode } from '../../lib/settingsIaPrototype';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultModelBar } from './DefaultModelBar';
import { IdentitySection } from './IdentitySection';
import { DefaultsTab, ModelsTab } from './ModelsSection';
import { OBJECTS_AI_TABS, PURPOSE_AI_PROVIDERS_TAB_LABEL_KEY } from './navPrototype';
import { ConnectionsTab } from './ProvidersSection';

/**
 * Visual tab order follows the path a person takes: connect something, see
 * the models it brings, then decide which model each job uses. Tab ids and
 * deep links are unchanged.
 */
const AI_TAB_ORDER: readonly AiSettingsTab[] = (['providers', 'models', 'defaults'] as const)
  .filter((candidate) => (AI_SETTINGS_TABS as readonly string[]).includes(candidate));

type AiPageTab = AiSettingsTab | 'identity';

/**
 * The merged "Models & providers" entry (settings redesign batch 2, §3.3 /
 * §7.1): one navigation leaf, three stable tabs — Connections (OAuth, API
 * keys, provider lifecycle), Available models (cross-provider catalog), and
 * Defaults (per-job models, request identity, thinking). The new-session
 * default model is a bar above all three, so it is stated once and reachable
 * from wherever the reader lands. The active tab is the `?tab=` query so deep
 * links, search hits, and the legacy `/settings/models` / `/settings/providers`
 * redirects all land on the right one; unknown values fall back to the default tab.
 *
 * IA experiment, `objects` mode: a fourth tab, Identity, mounts the request-
 * identity page in place (provider → model → defaults → identity is one
 * outbound-request path). `/settings/identity` redirects here while the mode
 * is on; with the mode off the tab list and routes are exactly the shipped ones.
 */
export function AiSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  const iaMode = useSyncExternalStore(subscribeIaPrototypeMode, iaPrototypeModeSnapshot, () => null);
  const tabOrder: readonly AiPageTab[] = iaMode === 'objects' ? OBJECTS_AI_TABS : AI_TAB_ORDER;
  const rawTab = new URLSearchParams(search).get('tab');
  const tab: AiPageTab = normalizeAiTab(rawTab)
    ?? (iaMode === 'objects' && rawTab === 'identity' ? 'identity' : AI_SETTINGS_DEFAULT_TAB);

  // Tab switches go through the guarded navigator: an unsaved provider draft
  // on the Connections tab arms the same leave-guard as a section switch.
  const selectTab = (next: AiPageTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    navigate(`/settings/ai?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <DefaultModelBar tab={tab === 'identity' ? 'defaults' : tab} />
      <div role="tablist" aria-label={t('st.section.ai')} className="flex gap-1 border-b border-hairline">
        {tabOrder.map((candidate) => {
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
              {t(iaMode === 'purpose' && candidate === 'providers' ? PURPOSE_AI_PROVIDERS_TAB_LABEL_KEY : aiTabLabelKey(candidate as AiSettingsTab))}
            </button>
          );
        })}
      </div>
      {tab === 'identity' ? <IdentitySection />
        : tab === 'providers' ? <ConnectionsTab />
        : tab === 'defaults' ? <DefaultsTab />
        : <ModelsTab />}
    </div>
  );
}
