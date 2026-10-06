import type { Klient } from '@kiki/klient';
import type { QueryClient } from '@tanstack/react-query';

const PLUGIN_QUERY_ROOTS = [
  ['plugin'],
  ['plugin-usage'],
  ['plugin-panels'],
  ['plugin-commands'],
  ['plugin-panel-document'],
  ['plugin-marketplace'],
  ['plugin-recommendations'],
  ['plugins'],
  ['skins'],
  ['agentCapabilities'],
  ['workspace-skills'],
  ['mcp-servers'],
  ['mcp-managed-servers'],
] as const;

/** Re-read plugin consumers without assuming a change has already finished applying. */
export async function invalidatePluginQueries(queries: QueryClient): Promise<void> {
  await Promise.all(PLUGIN_QUERY_ROOTS.map((queryKey) => queries.invalidateQueries({ queryKey: [...queryKey] })));
}

/** The server publishes reload, workspace choice and application completion on this bus event. */
export function subscribePluginFreshness(klient: Pick<Klient, 'events'>, queries: QueryClient): () => void {
  let active = true;
  const refresh = () => {
    void invalidatePluginQueries(queries).catch(() => undefined);
  };
  const subscription = klient.events.on('plugins.changed', () => {
    if (active) refresh();
  });
  void subscription.ready.then(() => {
    if (active) refresh();
  }).catch(() => undefined);
  return () => { active = false; subscription.dispose(); };
}
