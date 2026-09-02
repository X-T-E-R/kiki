import { useQuery } from '@tanstack/react-query';

import { useI18n } from '../../i18n';
import type { PluginSummary } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { Hint, InlineError } from '../controls';
import { SectionCard } from './SectionCard';

const BADGE_CLASS =
  'shrink-0 rounded-full border border-hairline bg-panel px-1.5 py-px text-[9px] font-medium tracking-wide text-ink-faint uppercase';

/** Contribution counts as a compact "3 skills · 2 MCP · 1 hook" summary line. */
function contributionSummary(
  plugin: PluginSummary,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const parts: string[] = [];
  if (plugin.skillCount > 0) parts.push(t('st.plugins.contrib.skills', { count: plugin.skillCount }));
  if (plugin.mcpServerCount > 0) parts.push(t('st.plugins.contrib.mcp', { count: plugin.mcpServerCount }));
  if (plugin.hookCount > 0) parts.push(t('st.plugins.contrib.hooks', { count: plugin.hookCount }));
  if (plugin.commandCount > 0) parts.push(t('st.plugins.contrib.commands', { count: plugin.commandCount }));
  return parts.length === 0 ? t('st.plugins.contrib.none') : parts.join(' · ');
}

function PluginRow({ plugin }: { plugin: PluginSummary }) {
  const { t } = useI18n();
  const broken = plugin.state === 'error' || plugin.hasErrors;
  return (
    <div className="rounded-lg border border-hairline bg-paper px-3 py-2" data-plugin-row={plugin.id}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-ink">{plugin.displayName}</p>
        {plugin.version !== undefined ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-faint">v{plugin.version}</span>
        ) : null}
        <span className={BADGE_CLASS}>
          {plugin.enabled ? t('st.plugins.enabled') : t('st.plugins.disabled')}
        </span>
        {broken ? (
          <span className="shrink-0 rounded-full border border-danger/40 bg-danger/10 px-1.5 py-px text-[9px] font-medium tracking-wide text-danger uppercase">
            {t('st.plugins.error')}
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{contributionSummary(plugin, t)}</p>
      {plugin.originalSource !== undefined ? (
        <p className="mt-0.5 truncate font-mono text-[10px] text-ink-faint" title={plugin.originalSource}>
          {plugin.originalSource}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Installed plugins (redesign §8.2, batch-3 reviewer scope ruling): a minimal
 * read-only leaf — enabled state, error state and the contribution summary
 * per plugin. The marketplace stays out of this leaf until batch 5.
 */
export function PluginsSection() {
  const { client } = useConnection();
  const { t } = useI18n();
  const pluginsQuery = useQuery({
    queryKey: ['plugins'],
    queryFn: () => client.listPlugins(),
    staleTime: 60_000,
  });
  const plugins = pluginsQuery.data?.plugins ?? [];

  return (
    <SectionCard id="st-card-plugins" title={t('st.plugins.title')}>
      <div className="space-y-2">
        <Hint>{t('st.plugins.hint')}</Hint>
        {pluginsQuery.isPending ? (
          <Hint>{t('st.plugins.loading')}</Hint>
        ) : pluginsQuery.isError ? (
          <InlineError error={pluginsQuery.error} />
        ) : plugins.length === 0 ? (
          <Hint>{t('st.plugins.empty')}</Hint>
        ) : (
          plugins.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} />)
        )}
      </div>
    </SectionCard>
  );
}
