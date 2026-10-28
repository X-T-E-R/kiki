import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

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
import { IdentitySection } from './IdentitySection';
import { DefaultsTab } from './ModelsSection';
import { ConnectionsTab } from './ProvidersSection';

/**
 * Visual tab order follows the path a person takes: connect something and
 * edit the models it brings, decide which model each job uses, and configure
 * how outbound requests identify themselves.
 */
const AI_TAB_ORDER: readonly AiSettingsTab[] = (['providers', 'defaults', 'identity'] as const)
  .filter((candidate) => (AI_SETTINGS_TABS as readonly string[]).includes(candidate));

/**
 * The merged "Models & providers" entry: one navigation leaf, three stable
 * tabs — Providers & accounts (OAuth, API keys, provider lifecycle, and each
 * connection's models with their one complete editor), Defaults (per-job
 * models, thinking, compaction), and Identity (request identity profiles,
 * version tracks, usage, observations).
 * The new-session default model is a bar above the tabs, so it is stated once
 * and reachable from wherever the reader lands. The active tab is the `?tab=`
 * query so deep links, search hits, and legacy `/settings/models`,
 * `/settings/providers`, and `/settings/identity` redirects all land on the
 * right one; unknown values fall back to the default tab.
 */
export function AiSection() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const rawNavigate = useNavigate();
  const { search, hash } = useLocation();
  const rawTab = new URLSearchParams(search).get('tab');
  const tab: AiSettingsTab = normalizeAiTab(rawTab) ?? AI_SETTINGS_DEFAULT_TAB;

  // The retired Models tab: its models are edited inside their connection
  // now, so an old `?tab=models` link is rewritten in place (with `?model=`
  // and any card hash kept) rather than left naming a tab that is not there.
  useEffect(() => {
    if (rawTab !== 'models') return;
    const params = new URLSearchParams(search);
    params.set('tab', AI_SETTINGS_DEFAULT_TAB);
    void rawNavigate(`/settings/ai?${params.toString()}${hash}`, { replace: true });
  }, [rawTab, search, hash, rawNavigate]);

  // Tab switches go through the guarded navigator: an unsaved provider or
  // identity draft arms the same leave-guard as a section switch.
  const selectTab = (next: AiSettingsTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    void navigate(`/settings/ai?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <DefaultModelBar tab={tab} />
      <div role="tablist" aria-label={t('st.section.ai')} className="flex flex-wrap gap-1 border-b border-hairline">
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
      {tab === 'defaults' ? <DefaultsTab />
        : tab === 'identity' ? <IdentitySection />
        : <ConnectionsTab />}
    </div>
  );
}
