/**
 * Settings → Plugins. One section, two pages: the installed list, and each
 * plugin's own settings page at `/settings/plugins?plugin=<id>`.
 *
 * What is not here is as deliberate as what is. Finding and installing a
 * plugin stays on the Capabilities market, which this leaf links to once. The
 * catalog address stays in that market's own Advanced block. The WebBridge
 * readiness card — an answer about browser control, not about a plugin —
 * lives on the browser page, with the rest of that answer.
 */

import { InstalledPluginsList } from './plugins/InstalledPluginsList';
import { PluginSettingsPage } from './plugins/PluginSettingsPage';

export function PluginsSection({ pluginId }: { readonly pluginId: string | null }) {
  return pluginId === null ? <InstalledPluginsList /> : <PluginSettingsPage pluginId={pluginId} />;
}