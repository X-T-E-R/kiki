import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  AI_SETTINGS_DEFAULT_TAB,
  AI_SETTINGS_TABS,
  aiTabLabelKey,
  normalizeAiTab,
  recipeSettingsIdFromQuery,
  type AiSettingsTab,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { DefaultModelBar } from './DefaultModelBar';
import { DefaultsTab } from './ModelsSection';
import { ConnectionsTab } from './ProvidersSection';
import { RecipesSection } from './RecipesSection';
import { SettingsTabs } from './SettingsPrimitives';

const RECIPES_LIBRARY_HASH = '#st-card-recipes-library';

/**
 * Settings › Models: one navigation leaf, three stable tabs — Connections
 * (account sign-ins, API services, local servers and their models), Defaults
 * (per-job models, thinking, compaction, concurrency limits), and Recipes.
 * The status card sits above the tab strip on every tab.
 */
export function AiSection({ resolvedTab }: { resolvedTab?: AiSettingsTab } = {}) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const rawNavigate = useNavigate();
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  const rawTab = params.get('tab');
  const tab: AiSettingsTab = normalizeAiTab(rawTab ?? resolvedTab) ?? AI_SETTINGS_DEFAULT_TAB;
  const activeRecipeId = tab === 'recipes' && hash !== RECIPES_LIBRARY_HASH
    ? recipeSettingsIdFromQuery(search)
    : null;
  const recipeInitialEdit = activeRecipeId !== null && params.get('view') === 'edit';

  // The retired Models tab: its models are edited inside their connection
  // now, so an old `?tab=models` link is rewritten in place (with `?model=`
  // and any card hash kept) rather than left naming a tab that is not there.
  useEffect(() => {
    if (rawTab !== 'models') return;
    const next = new URLSearchParams(search);
    next.set('tab', AI_SETTINGS_DEFAULT_TAB);
    void rawNavigate(`/settings/ai?${next.toString()}${hash}`, { replace: true });
  }, [rawTab, search, hash, rawNavigate]);

  // Tab switches go through the guarded navigator: an unsaved provider or
  // recipe draft arms the same leave-guard as a section switch.
  const selectTab = (next: AiSettingsTab) => {
    if (next === tab) return;
    const nextParams = new URLSearchParams(search);
    if (next !== 'recipes') {
      nextParams.delete('recipe');
      nextParams.delete('view');
    }
    nextParams.set('tab', next);
    void navigate(`/settings/ai?${nextParams.toString()}`);
  };

  return (
    <div className="space-y-4">
      <DefaultModelBar tab={tab} />
      <SettingsTabs
        tabs={AI_SETTINGS_TABS}
        current={tab as (typeof AI_SETTINGS_TABS)[number]}
        ariaLabel={t('st.section.ai')}
        dataAttr="data-ai-tab"
        labelOf={(candidate) => t(aiTabLabelKey(candidate))}
        onSelect={selectTab}
      />
      {tab === 'defaults' ? <DefaultsTab />
        : tab === 'recipes' ? <RecipesSection recipeId={activeRecipeId} initialEdit={recipeInitialEdit} />
        : <ConnectionsTab />}
    </div>
  );
}
