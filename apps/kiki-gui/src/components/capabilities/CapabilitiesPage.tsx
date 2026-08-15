/**
 * CapabilitiesPage (/capabilities) — a read-mostly inventory of what the
 * connected server can do in the current workspace: the skill catalog grouped
 * by source (plugin / project / user / extra / builtin) plus the MCP servers
 * with status and restart. Grouping and filtering live in lib/capabilities
 * (pure, unit-tested); this file owns data fetching and presentation.
 *
 * Workspace resolution mirrors the settings skills card: an explicit
 * `?workspace=` deep-link wins, otherwise the first registered workspace.
 * Without any workspace the skill groups degrade to a quiet hint while the
 * (workspace-independent) MCP group still renders.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useI18n } from '../../i18n';
import {
  filterMcpServers,
  groupSkills,
  normalizeCapQuery,
  pickWorkspace,
  SKILL_GROUP_ORDER,
  type SkillGroupId,
} from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { Hint, InlineError } from '../controls';
import { SMALL_INPUT } from '../ui';
import { CapabilityGroup } from './CapabilityGroup';
import { McpServerRow, SkillCard } from './rows';

/** Groups collapsed on first paint: builtin is long and rarely the answer. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<string> = new Set(['builtin', 'other']);

const SOURCE_LABEL_KEYS = {
  plugin: 'cap.source.plugin',
  project: 'cap.source.project',
  user: 'cap.source.user',
  extra: 'cap.source.extra',
  builtin: 'cap.source.builtin',
} as const;

const GROUP_TITLE_KEYS = {
  plugin: 'cap.group.plugin',
  project: 'cap.group.project',
  user: 'cap.group.user',
  extra: 'cap.group.extra',
  builtin: 'cap.group.builtin',
  other: 'cap.group.other',
  mcp: 'cap.group.mcp',
} as const;

export function CapabilitiesPage({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { client } = useConnection();
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const requestedWorkspace = searchParams.get('workspace') ?? undefined;
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspace = useMemo(
    () => pickWorkspace(workspacesQuery.data?.items ?? [], requestedWorkspace),
    [workspacesQuery.data, requestedWorkspace],
  );
  const skillsQuery = useQuery({
    queryKey: ['workspace-skills', workspace?.id ?? ''],
    queryFn: () => client.listWorkspaceSkills(workspace?.id ?? ''),
    enabled: workspace !== undefined,
    staleTime: 60_000,
  });
  const mcpQuery = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => client.listMcpServers(),
    staleTime: 60_000,
  });

  const query = normalizeCapQuery(filter);
  const filtering = query !== '';
  const groups = useMemo(
    () => groupSkills(skillsQuery.data?.skills ?? [], filter),
    [skillsQuery.data, filter],
  );
  // Without a filter every known group renders (empty ones with their own
  // quiet empty state); with a filter only groups holding matches survive.
  const visibleGroups = useMemo(() => {
    if (filtering) return groups;
    return SKILL_GROUP_ORDER.filter((id) => id !== 'other' || groups.some((g) => g.id === 'other'))
      .map((id) => ({
        id,
        skills: groups.find((g) => g.id === id)?.skills ?? [],
      }));
  }, [filtering, groups]);
  const mcpServers = useMemo(
    () => filterMcpServers(mcpQuery.data?.servers ?? [], filter),
    [mcpQuery.data, filter],
  );

  const nothingMatched =
    filtering &&
    visibleGroups.every((group) => group.skills.length === 0) &&
    mcpServers.length === 0;

  const isOpen = (id: string) =>
    filtering ? true : !(collapsed[id] ?? COLLAPSED_BY_DEFAULT.has(id));
  const toggle = (id: string) => {
    setCollapsed((current) => ({ ...current, [id]: !(current[id] ?? COLLAPSED_BY_DEFAULT.has(id)) }));
  };

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-hairline bg-panel px-4">
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={t('sv.openMenuAria')}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink md:hidden"
        >
          <span aria-hidden>☰</span>
        </button>
        <h1 className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
          {t('cap.title')}
        </h1>
        {workspace !== undefined ? (
          <p className="hidden shrink-0 truncate font-mono text-[10.5px] text-ink-faint sm:block">
            {t('cap.workspaceEcho', { name: workspace.name })}
          </p>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-8">
        <div className="anim-enter mx-auto max-w-[860px] space-y-4" data-capabilities-page>
          <input
            type="text"
            value={filter}
            onChange={(event) => { setFilter(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setFilter('');
            }}
            placeholder={t('cap.filterPlaceholder')}
            aria-label={t('cap.filterAria')}
            className={`${SMALL_INPUT} w-full sm:w-80`}
          />

          {workspacesQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('cap.loadingSkills')}
            </div>
          ) : workspacesQuery.isError ? (
            <div className="rounded-2xl border border-danger/30 bg-danger/5 p-5">
              <p className="text-[12.5px] font-medium text-danger">{t('cap.loadFailed')}</p>
              <p className="mt-1 font-mono text-[10.5px] text-danger/80">
                {workspacesQuery.error instanceof Error
                  ? workspacesQuery.error.message
                  : t('common.unknownError')}
              </p>
              <button
                type="button"
                onClick={() => void workspacesQuery.refetch()}
                className="mt-2 text-[11.5px] font-medium text-danger underline"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : workspace === undefined ? (
            <div className="rounded-2xl border border-hairline bg-panel px-4 py-6">
              <Hint>{t('cap.noWorkspace')}</Hint>
            </div>
          ) : (
            <>
              {skillsQuery.isPending ? (
                <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
                  <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
                  {t('cap.loadingSkills')}
                </div>
              ) : skillsQuery.isError ? (
                <div className="rounded-2xl border border-hairline bg-panel p-4">
                  <InlineError error={skillsQuery.error} />
                </div>
              ) : (
                visibleGroups.map((group) => (
                  <CapabilityGroup
                    key={group.id}
                    id={group.id}
                    title={t(GROUP_TITLE_KEYS[group.id])}
                    count={group.skills.length}
                    open={isOpen(group.id)}
                    onToggle={() => { toggle(group.id); }}
                  >
                    {group.skills.length === 0 ? (
                      <Hint>{t('cap.emptyGroup')}</Hint>
                    ) : (
                      group.skills.map((skill) => (
                        <SkillCard
                          key={`${skill.source}:${skill.name}`}
                          skill={skill}
                          sourceLabel={
                            group.id === 'other'
                              ? skill.source
                              : t(SOURCE_LABEL_KEYS[group.id as Exclude<SkillGroupId, 'other'>])
                          }
                        />
                      ))
                    )}
                  </CapabilityGroup>
                ))
              )}
            </>
          )}

          {mcpQuery.isPending ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-hairline bg-panel px-4 py-10 text-[12px] text-ink-faint">
              <span className="status-dot-busy h-1.5 w-1.5 rounded-full bg-accent" />
              {t('cap.loadingMcp')}
            </div>
          ) : mcpQuery.isError ? (
            <div className="rounded-2xl border border-hairline bg-panel p-4">
              <InlineError error={mcpQuery.error} />
            </div>
          ) : filtering && mcpServers.length === 0 ? null : (
            <CapabilityGroup
              id="mcp"
              title={t(GROUP_TITLE_KEYS.mcp)}
              count={mcpServers.length}
              open={isOpen('mcp')}
              onToggle={() => { toggle('mcp'); }}
            >
              {mcpServers.length === 0 ? (
                <Hint>{t('cap.emptyGroup')}</Hint>
              ) : (
                mcpServers.map((server) => <McpServerRow key={server.id} server={server} />)
              )}
            </CapabilityGroup>
          )}

          {nothingMatched ? (
            <p className="rounded-2xl border border-hairline bg-panel px-4 py-10 text-center text-[12.5px] text-ink-faint">
              {t('cap.emptyFilter', { query: filter.trim() })}
            </p>
          ) : null}
        </div>
      </main>
    </>
  );
}
