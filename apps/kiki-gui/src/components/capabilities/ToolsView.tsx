/**
 * Tools — everything the agent can call on this server, grouped by where it
 * comes from (built-in, MCP, plugin). Read-only here: enabling and disabling
 * tools per agent lives in the profile editor, and the global policy in
 * Settings. Names are shown as the model sees them after the source prefix.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { ToolDescriptor } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { toolDisplayName } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { InlineError } from '../controls';
import { CapabilityIcon } from './CapabilityIcon';
import { CapabilityRow, CapabilitySection, EmptyNote, RowGrid, SearchField, Tag } from './primitives';

const SOURCE_ORDER: readonly ToolDescriptor['source'][] = ['builtin', 'plugin', 'mcp', 'skill'];
const SOURCE_TITLE = {
  builtin: 'cap.tools.builtin',
  plugin: 'cap.tools.plugin',
  mcp: 'cap.tools.mcp',
  skill: 'cap.tools.skill',
} as const;

export function ToolsView() {
  const { client } = useConnection();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const toolsQuery = useQuery({
    queryKey: ['tools', 'global'],
    queryFn: () => client.listTools(),
    staleTime: 30_000,
  });
  const needle = query.trim().toLowerCase();
  const tools = useMemo(
    () => (toolsQuery.data?.tools ?? []).filter((tool) => needle === ''
      || tool.name.toLowerCase().includes(needle)
      || tool.description.toLowerCase().includes(needle)),
    [toolsQuery.data, needle],
  );

  return (
    <div className="min-w-0 space-y-8" data-tools-view>
      <SearchField value={query} onChange={setQuery} placeholder={t('cap.tools.search')} ariaLabel={t('cap.tools.search')} />
      {toolsQuery.isPending ? (
        <p className="text-[13px] text-ink-faint" role="status">{t('cap.loading')}</p>
      ) : toolsQuery.isError ? (
        <InlineError error={toolsQuery.error} />
      ) : tools.length === 0 ? (
        <EmptyNote title={needle === '' ? t('cap.tools.none') : t('cap.emptyFilter', { query: query.trim() })} />
      ) : (
        SOURCE_ORDER.map((source) => {
          const group = tools.filter((tool) => tool.source === source);
          if (group.length === 0) return null;
          return (
            <CapabilitySection key={source} id={`tools-${source}`} title={t(SOURCE_TITLE[source])} count={group.length}>
              <RowGrid>
                {group.map((tool) => (
                  <CapabilityRow
                    key={tool.name}
                    dataAttrs={{ 'data-tool-row': tool.name }}
                    icon={<CapabilityIcon kind="tool" size="sm" />}
                    title={toolDisplayName(tool.name)}
                    badge={tool.active === false ? <Tag>{t('cap.state.off')}</Tag> : undefined}
                    meta={tool.description.split('\n', 1)[0]}
                  />
                ))}
              </RowGrid>
            </CapabilitySection>
          );
        })
      )}
    </div>
  );
}
