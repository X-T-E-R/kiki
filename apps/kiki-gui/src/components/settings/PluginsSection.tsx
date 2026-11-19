import { useLocation } from 'react-router-dom';

import { useGuardedNavigate } from '../dirtyGuard';
import { InstalledPluginsList } from './plugins/InstalledPluginsList';
import { PluginSettingsPage } from './plugins/PluginSettingsPage';

/**
 * Settings -> Plugins: direct installed + market plugin management on the list
 * view, and each plugin's settings page at `?plugin=<id>`.
 */
export function PluginsSection({ pluginId }: { readonly pluginId: string | null }) {
  const location = useLocation();
  const navigate = useGuardedNavigate();
  if (pluginId === null) return <InstalledPluginsList />;

  const backToCurrentSection = location.pathname.startsWith('/settings/extensions')
    ? () => {
        const params = new URLSearchParams(location.search);
        params.delete('plugin');
        const nextQuery = params.toString();
        void navigate(nextQuery === '' ? '/settings/extensions' : `/settings/extensions?${nextQuery}`);
      }
    : undefined;

  return <PluginSettingsPage pluginId={pluginId} onBack={backToCurrentSection} />;
}
