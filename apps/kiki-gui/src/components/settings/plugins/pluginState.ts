import type { I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../../i18n';
import type { PluginSummary } from '../../../lib/client';

/**
 * A plugin has two independent switches, the same pair every optional system
 * capability has: 启用 (it may run at all) and 新会话默认开启 (it starts on in a
 * session nobody chose for). Older servers only report `globalEnabled`, which
 * is the pair already combined; it is the best reading they allow.
 */
export function pluginDefaultOn(plugin: PluginSummary): boolean {
  return plugin.defaultEnabled ?? plugin.globalEnabled;
}

/** One status phrase for a plugin, in the words of the two switches. */
export function pluginStatusKey(plugin: PluginSummary): I18nKey {
  if (!plugin.enabled) return 'st.plugins.status.off';
  return pluginDefaultOn(plugin) ? 'st.plugins.status.defaultOn' : 'st.plugins.status.onDemand';
}

/** "1 个技能 · 2 个 MCP 服务器" — what turning the plugin on brings, or '' for nothing. */
export function usePluginContributions(plugin: PluginSummary): string {
  const { tp } = useI18n();
  const parts: string[] = [];
  if (plugin.skillCount > 0) parts.push(tp('st.plugins.contrib.skills', plugin.skillCount));
  if (plugin.mcpServerCount > 0) parts.push(tp('st.plugins.contrib.mcp', plugin.mcpServerCount));
  if (plugin.hookCount > 0) parts.push(tp('st.plugins.contrib.hooks', plugin.hookCount));
  if (plugin.commandCount > 0) parts.push(tp('st.plugins.contrib.commands', plugin.commandCount));
  return parts.join(' · ');
}
