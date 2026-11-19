import { useState } from 'react';
import { useLocation } from 'react-router-dom';

import { importHistoryPath, pluginSettingsPath, readLastSessionId } from '@kiki/session-core/settings';
import { useI18n } from '../../../i18n';
import { useCapabilityWorkspace } from '../../capabilities/CapabilitiesPage';
import { PluginsView, type PluginsRoute } from '../../capabilities/PluginsView';
import { useGuardedNavigate } from '../../dirtyGuard';
import { SectionCard } from '../SectionCard';
import { ORIGIN_KEYS } from './pluginState';

export { ORIGIN_KEYS };

/**
 * Direct Plugins management inside Settings (`#st-card-plugins`), shared by
 * `Settings -> Plugins` (`/settings/plugins`) and `Settings -> Extensions -> Plugins`
 * (`/settings/extensions`).
 */
export function InstalledPluginsList() {
  const { t } = useI18n();
  const navigate = useGuardedNavigate();
  const location = useLocation();
  const { workspace } = useCapabilityWorkspace();
  const [route, setRoute] = useState<PluginsRoute>({ view: 'installed' });

  const openPluginSettings = (id: string) => {
    if (location.pathname.startsWith('/settings/extensions')) {
      const params = new URLSearchParams(location.search);
      params.set('plugin', id);
      void navigate(`/settings/extensions?${params.toString()}`);
      return;
    }
    void navigate(pluginSettingsPath(id));
  };

  return (
    <SectionCard id="st-card-plugins" title={t('st.plugins.installedTitle')}>
      <PluginsView
        route={route}
        onRoute={setRoute}
        workspaceRoot={workspace?.root}
        sessionId={readLastSessionId() ?? undefined}
        onOpenSettings={openPluginSettings}
        onOpenPanel={(pluginId, panelId) => {
          void navigate(`/capabilities?plugin=${encodeURIComponent(pluginId)}&panel=${encodeURIComponent(`${pluginId}:${panelId}`)}`);
        }}
        onOpenImportHistory={({ source, sourcePlugin }) => {
          void navigate(`${importHistoryPath()}?source=${encodeURIComponent(source)}&sourcePlugin=${encodeURIComponent(sourcePlugin)}`);
        }}
        inSettings
      />
    </SectionCard>
  );
}
