import { useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { sortWorkspacesByRecency } from '@kiki/session-core/sessions';
import { mcpTimeoutsPatch } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { pickWorkspace } from '../../lib/capabilities';
import { useConnection } from '../../state/connection';
import { McpServerRow } from '../capabilities/rows';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { SearchableSelect, type SearchableSelectOption } from '../SearchableSelect';
import { INPUT, PRIMARY_BUTTON } from '../ui';
import { McpConfigManager } from './McpConfigManager';
import { SectionCard } from './SectionCard';
import { SettingsWorkspaceScopeContext } from './workspaceScope';

function optionalNumberDraft(value: number | null | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
}

/** Live MCP server list (status / last error / restart), re-homed from /capabilities. */
function McpStatusCard() {
  const { client } = useConnection();
  const { t } = useI18n();
  const mcpQuery = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => client.listMcpServers(),
    staleTime: 60_000,
  });
  const servers = mcpQuery.data?.servers ?? [];

  return (
    <SectionCard id="st-card-mcp-status" title={t('st.mcp.statusTitle')}>
      <div className="space-y-2">
        {mcpQuery.isPending ? (
          <Hint>{t('cap.loadingMcp')}</Hint>
        ) : mcpQuery.isError ? (
          <InlineError error={mcpQuery.error} />
        ) : servers.length === 0 ? (
          <Hint>{t('cap.emptyGroup')}</Hint>
        ) : (
          servers.map((server) => <McpServerRow key={server.id} server={server} />)
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Server-wide MCP timeouts (redesign §8.3): they moved back next to the MCP
 * config they govern. The patch stays scoped to the `mcp` replace-domain so a
 * save here never rewrites the other runtime domains.
 */
function McpTimeoutsCard() {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [startupTimeoutMs, setStartupTimeoutMs] = useState('');
  const [toolTimeoutMs, setToolTimeoutMs] = useState('');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined) return;
    setStartupTimeoutMs(optionalNumberDraft(config.mcp?.startupTimeoutMs));
    setToolTimeoutMs(optionalNumberDraft(config.mcp?.toolTimeoutMs));
  }, [configQuery.data]);

  const save = async () => {
    let patch;
    try {
      patch = mcpTimeoutsPatch(startupTimeoutMs, toolTimeoutMs);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const echoed = await client.patchConfig(patch);
      queryClient.setQueryData(['config'], echoed);
      setStartupTimeoutMs(optionalNumberDraft(echoed.mcp?.startupTimeoutMs));
      setToolTimeoutMs(optionalNumberDraft(echoed.mcp?.toolTimeoutMs));
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      setFeedback({ tone: 'success', text: t('st.mcp.timeoutsSaved') });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard id="st-card-mcp-timeouts" title={t('st.mcp.timeoutsTitle')}>
      <div className="space-y-3">
        <Hint>{t('st.mcp.timeoutsHint')}</Hint>
        <fieldset disabled={saving} className="grid gap-3 sm:grid-cols-2 disabled:opacity-60">
          <label className="text-[11px] font-medium text-ink-soft">
            {t('st.runtime.mcpStartupTimeout')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              inputMode="numeric"
              value={startupTimeoutMs}
              onChange={(event) => { setStartupTimeoutMs(event.target.value); }}
            />
          </label>
          <label className="text-[11px] font-medium text-ink-soft">
            {t('st.runtime.mcpToolTimeout')}
            <input
              className={`${INPUT} mt-1 font-mono`}
              inputMode="numeric"
              value={toolTimeoutMs}
              onChange={(event) => { setToolTimeoutMs(event.target.value); }}
            />
          </label>
        </fieldset>
        <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void save()}>{saving ? t('common.saving') : t('common.save')}</button>
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * MCP leaf (redesign §8.2 / §10.3): per-workspace server configuration (the
 * v2 management plane addresses project layers by working directory), the
 * live status list, and the server-wide timeouts.
 */
export function McpSection() {
  const { client, klient } = useConnection();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedWorkspace = searchParams.get('workspace') ?? undefined;
  const [workspaceId, setWorkspaceId] = useState('');

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspaces = workspacesQuery.data?.items ?? [];
  const sortedWorkspaces = useMemo(() => sortWorkspacesByRecency(workspaces), [workspaces]);
  const workspaceOptions: readonly SearchableSelectOption[] = useMemo(
    () =>
      sortedWorkspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        hint: workspace.root,
        title: workspace.name,
      })),
    [sortedWorkspaces],
  );
  useEffect(() => {
    if (workspaceId !== '') return;
    const picked = pickWorkspace(sortedWorkspaces, requestedWorkspace);
    if (picked !== undefined) setWorkspaceId(picked.id);
  }, [workspaceId, sortedWorkspaces, requestedWorkspace]);

  // The scope header names the workspace this section's MCP edits target;
  // switching the selector updates the page header in lockstep.
  const reportWorkspaceScope = useContext(SettingsWorkspaceScopeContext);
  const workspaceScopeName = sortedWorkspaces.find((workspace) => workspace.id === workspaceId)?.name ?? null;
  useEffect(() => {
    reportWorkspaceScope(workspaceScopeName);
    return () => { reportWorkspaceScope(null); };
  }, [reportWorkspaceScope, workspaceScopeName]);

  const mcpCwd = sortedWorkspaces.find((workspace) => workspace.id === workspaceId)?.root ?? '';
  const mcpConfigQuery = useQuery({
    queryKey: ['mcp-managed-servers', mcpCwd],
    queryFn: () => klient.global.mcp.list({ cwd: mcpCwd === '' ? undefined : mcpCwd }),
    staleTime: 60_000,
  });

  return (
    <div className="space-y-4">
      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-ink-soft">{t('st.mcp.workspace')}</span>
            <SearchableSelect
              id="workspace-mcp-select"
              options={workspaceOptions}
              value={workspaceId}
              onChange={setWorkspaceId}
              ariaLabel={t('st.mcp.workspace')}
            />
          </div>
          <McpConfigManager
            cwd={mcpCwd}
            entries={mcpConfigQuery.data ?? []}
            loading={mcpConfigQuery.isLoading}
            error={mcpConfigQuery.error}
            onEcho={(servers) => {
              queryClient.setQueryData(['mcp-managed-servers', mcpCwd], servers);
            }}
          />
        </div>
      </SectionCard>
      <McpStatusCard />
      <McpTimeoutsCard />
    </div>
  );
}
