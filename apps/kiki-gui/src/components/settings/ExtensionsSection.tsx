import { useLocation } from 'react-router-dom';

import {
  EXTENSIONS_SETTINGS_DEFAULT_TAB,
  EXTENSIONS_SETTINGS_TABS,
  extensionsTabLabelKey,
  normalizeExtensionsTab,
  type ExtensionsSettingsTab,
} from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useGuardedNavigate } from '../dirtyGuard';
import { McpSection } from './McpSection';
import { PluginsSection } from './PluginsSection';
import { SkillsSection } from './SkillsSection';

/**
 * Extensions & tools: unified direct management tabs for Plugins, Skills, and
 * MCP servers. When `?plugin=<id>` is present, that plugin's own settings page
 * renders directly and returns to this section on Back.
 */
export function ExtensionsSection({ pluginId }: { readonly pluginId: string | null }) {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const { search } = useLocation();
  const rawTab = new URLSearchParams(search).get('tab');
  const tab: ExtensionsSettingsTab = normalizeExtensionsTab(rawTab) ?? EXTENSIONS_SETTINGS_DEFAULT_TAB;

  if (pluginId !== null) {
    return <PluginsSection pluginId={pluginId} />;
  }

  const selectTab = (next: ExtensionsSettingsTab) => {
    if (next === tab) return;
    const params = new URLSearchParams(search);
    params.set('tab', next);
    params.delete('plugin');
    void navigate(`/settings/extensions?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={t('st.section.extensions')} className="flex flex-wrap gap-1 border-b border-hairline">
        {EXTENSIONS_SETTINGS_TABS.map((candidate) => {
          const active = candidate === tab;
          return (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={active}
              data-extensions-tab={candidate}
              onClick={() => { selectTab(candidate); }}
              className={`-mb-px min-h-9 border-b-2 px-3 py-1.5 text-[13px] transition-colors ${
                active
                  ? 'border-ink font-medium text-ink'
                  : 'border-transparent text-ink-soft hover:text-ink'
              }`}
            >
              {t(extensionsTabLabelKey(candidate))}
            </button>
          );
        })}
      </div>
      <div>
        {tab === 'skills' ? <SkillsSection />
          : tab === 'mcp' ? <McpSection />
          : <PluginsSection pluginId={null} />}
      </div>
    </div>
  );
}
