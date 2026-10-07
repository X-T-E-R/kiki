import { useContext, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import { mcpTimeoutsPatch, workspacesSettingsPath } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { CapabilityLink } from '../capabilities/CapabilityLink';
import { FeedbackLine, Hint, InlineError, type Feedback } from '../controls';
import { Spinner } from '../icons';
import { McpConfigManager } from './McpConfigManager';
import { SectionCard } from './SectionCard';
import { SettingsWorkspaceScopeContext } from './workspaceScope';
import { NumberField } from './runtimeControls';
import { SettingsDraftFooter } from './SettingsPrimitives';
import { useSavedTick } from './useSavedTick';

function optionalNumberDraft(value: number | null | undefined): string {
  return value === null ? 'null' : value === undefined ? '' : String(value);
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
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [justSaved, pingSaved] = useSavedTick();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });

  useEffect(() => {
    const config = configQuery.data;
    if (config === undefined || dirty) return;
    setStartupTimeoutMs(optionalNumberDraft(config.mcp?.startupTimeoutMs));
    setToolTimeoutMs(optionalNumberDraft(config.mcp?.toolTimeoutMs));
  }, [configQuery.data, dirty]);

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
      setDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
      pingSaved();
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
          <NumberField
            label={t('st.runtime.mcpStartupTimeout')}
            value={startupTimeoutMs}
            hint={t('st.mcp.startupTimeoutHint')}
            detail={t('st.mcp.startupTimeoutDetail')}
            onChange={(next) => { setStartupTimeoutMs(next); setDirty(true); }}
          />
          <NumberField
            label={t('st.runtime.mcpToolTimeout')}
            value={toolTimeoutMs}
            hint={t('st.mcp.toolTimeoutHint')}
            detail={t('st.mcp.toolTimeoutDetail')}
            onChange={(next) => { setToolTimeoutMs(next); setDirty(true); }}
          />
        </fieldset>
        <SettingsDraftFooter saved={justSaved} id="mcp-timeouts" dirty={dirty} saving={saving} onSave={() => void save()}
          onDiscard={() => { setStartupTimeoutMs(optionalNumberDraft(configQuery.data?.mcp?.startupTimeoutMs)); setToolTimeoutMs(optionalNumberDraft(configQuery.data?.mcp?.toolTimeoutMs)); setDirty(false); setFeedback(null); }} />
        {configQuery.isError ? <InlineError error={configQuery.error} /> : null}
        <FeedbackLine feedback={feedback} />
      </div>
    </SectionCard>
  );
}

/**
 * MCP leaf: the server-wide defaults, and — when the address names one
 * workspace — the entries that workspace can actually see.
 *
 * `?workspace=<id>` is what a workspace's own page links with, and it means the
 * entries have to be read at THAT workspace's root: the management plane
 * addresses project layers by cwd, so a leaf that ignored the query would show
 * the home configuration under a page that said "Scopes workspace". The scope
 * being edited is reported back to the settings frame, which names it beside
 * the card title, and a workspace this server no longer has says so instead of
 * quietly falling back to another workspace or to the home list.
 *
 * The entries themselves are the existing manager with its existing rules:
 * plugin and project entries stay read-only, a global entry stays editable and
 * names where it writes, and nothing here invents a scope of its own.
 */
export function McpSection() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const workspaceId = params.get('workspace') ?? '';
  if (workspaceId !== '') return (
    <div className="space-y-6">
      <WorkspaceMcpEntries workspaceId={workspaceId} />
      <McpTimeoutsCard />
    </div>
  );
  return (
    <div className="space-y-6">
      <SectionCard id="st-card-mcp" title={t('st.mcp.title')}>
        <CapabilityLink kind="mcp" />
      </SectionCard>
      <McpTimeoutsCard />
    </div>
  );
}

/**
 * One workspace's configured entries, read at its own root. A workspace the
 * server no longer has is a dead link, not a reason to edit something else, so
 * it reads as one.
 */
function WorkspaceMcpEntries({ workspaceId }: { readonly workspaceId: string }) {
  const { t } = useI18n();
  const { client, klient } = useConnection();
  const queryClient = useQueryClient();
  const reportScope = useContext(SettingsWorkspaceScopeContext);
  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    staleTime: 30_000,
  });
  const workspace = workspacesQuery.data?.items.find((item) => item.id === workspaceId);
  const entriesQuery = useQuery({
    queryKey: ['mcp-managed-servers', workspace?.root ?? ''],
    queryFn: () => klient.global.mcp.list({ cwd: workspace!.root }),
    enabled: workspace !== undefined,
    staleTime: 60_000,
  });
  // The frame's scope line names this workspace, so no control below can be
  // read as a home-scope edit made by accident.
  useEffect(() => {
    reportScope(workspace?.name ?? null);
    return () => { reportScope(null); };
  }, [reportScope, workspace?.name]);

  if (workspacesQuery.isPending) {
    return <p role="status" data-mcp-workspace-loading className="flex items-center gap-2 text-[13px] text-ink-faint"><Spinner label={t('cap.loading')} />{t('cap.loading')}</p>;
  }
  if (workspacesQuery.isError) {
    return (
      <div className="space-y-2" data-mcp-workspace-error>
        <InlineError error={workspacesQuery.error} />
        <button type="button" className="min-h-8 rounded-md bg-ink/[0.06] px-3 text-[13px] text-ink hover:bg-ink/[0.1]" onClick={() => { void workspacesQuery.refetch(); }}>{t('common.retry')}</button>
      </div>
    );
  }
  if (workspace === undefined) {
    return (
      <div className="space-y-3 py-2" data-mcp-workspace-missing>
        <div>
          <h2 className="font-display text-[18px] leading-6 text-ink">{t('st.workspaces.detail.missingTitle')}</h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-5 text-ink-soft">{t('st.workspaces.detail.missingBody')}</p>
        </div>
        <Link to={workspacesSettingsPath()} className="inline-flex min-h-8 items-center rounded-md px-3 text-[13px] text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink" data-mcp-workspace-back>
          {t('st.workspaces.title')}
        </Link>
      </div>
    );
  }
  return (
    <SectionCard id="st-card-mcp" title={t('st.mcp.title')} scope="workspace">
      <p className="min-w-0 truncate text-[12.5px] leading-5 text-ink-soft" data-mcp-workspace-name>{workspace.name}</p>
      <p className="min-w-0 truncate font-mono text-[12px] text-ink-faint" data-mcp-workspace-root title={workspace.root}>
        {workspace.root}
      </p>
      <div className="mt-3">
        <McpConfigManager
          cwd={workspace.root}
          entries={entriesQuery.data ?? []}
          loading={entriesQuery.isLoading}
          error={entriesQuery.error}
          onEcho={(servers) => { queryClient.setQueryData(['mcp-managed-servers', workspace.root], servers); }}
        />
      </div>
    </SectionCard>
  );
}
