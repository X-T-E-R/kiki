/**
 * MCP servers — one list where configuration and live state meet (Zed /
 * Cursor row grammar): name + status dot + transport · tools; an error line
 * replaces the fact line in danger; "Reconnect" appears only when there is
 * something to reconnect. Expanding a row shows its tools, the full error,
 * where it was configured, and the destructive actions.
 *
 * The runtime list (`/mcp/runtime/servers`) is server-wide; configuration is
 * per workspace (the management plane addresses project layers by cwd).
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { Workspace } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { toolDisplayName } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, type Feedback } from '../controls';
import { McpConfigManager } from '../settings/McpConfigManager';

function pathKey(path: string): string | undefined {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(path);
  if (!windows && !path.startsWith('/')) return undefined;
  const normalized = windows ? path.replaceAll('\\', '/').toLowerCase() : path;
  const prefix = normalized.startsWith('//')
    ? `//${normalized.slice(2).split('/').slice(0, 2).join('/')}/`
    : windows ? normalized.slice(0, 3) : '/';
  const segments: string[] = [];
  for (const segment of normalized.slice(prefix.length).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return prefix + segments.join('/');
}

/** Workspaces come from the active connection's scoped query cache; match the deepest directory, never a string prefix. */
export function findMcpWorkspace(cwd: string, workspaces: readonly Workspace[]): Workspace | undefined {
  const target = pathKey(cwd);
  if (target === undefined) return undefined;
  let matched: Workspace | undefined;
  let depth = -1;
  for (const workspace of workspaces) {
    const root = pathKey(workspace.root);
    if (root !== undefined && (target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)) && root.length > depth) {
      matched = workspace;
      depth = root.length;
    }
  }
  return matched;
}

export function McpView({ cwd }: { readonly cwd: string }) {
  const { client, klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => client.listWorkspaces(),
    enabled: cwd !== '',
    staleTime: 30_000,
  });

  const matchedWorkspace = useMemo(() => findMcpWorkspace(cwd, workspacesQuery.data?.items ?? []), [cwd, workspacesQuery.data]);

  const trustQuery = useQuery({
    queryKey: ['workspace-trust', matchedWorkspace?.id],
    queryFn: () => client.getWorkspaceTrust(matchedWorkspace!.id),
    enabled: matchedWorkspace !== undefined,
    staleTime: 30_000,
  });

  const isTrusted = trustQuery.data?.trusted ?? false;

  const toggleTrust = async () => {
    if (!matchedWorkspace || trustBusy || trustQuery.data === undefined || trustQuery.isError) return;
    setTrustBusy(true);
    setFeedback(null);
    try {
      const res = isTrusted
        ? await client.untrustWorkspace(matchedWorkspace.id)
        : await client.trustWorkspace(matchedWorkspace.id);
      queryClient.setQueryData(['workspace-trust', matchedWorkspace.id], res);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-managed-servers', cwd] }),
        queryClient.invalidateQueries({ queryKey: ['tools', 'global'] }),
      ]);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setTrustBusy(false);
    }
  };

  const runtimeQuery = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: () => client.listMcpServers(),
    staleTime: 15_000,
    refetchInterval: (query) => query.state.data?.servers.some((server) => server.status === 'connecting') === true ? 2_000 : false,
  });
  const toolsQuery = useQuery({
    queryKey: ['tools', 'global'],
    queryFn: () => client.listTools(),
    staleTime: 30_000,
    retry: false,
  });
  const configQuery = useQuery({
    queryKey: ['mcp-managed-servers', cwd],
    queryFn: () => klient.global.mcp.list({ cwd: cwd === '' ? undefined : cwd }),
    staleTime: 60_000,
  });

  const toolsByServer = new Map<string, string[]>();
  for (const tool of toolsQuery.data?.tools ?? []) {
    if (tool.source !== 'mcp' || tool.mcp_server_id === undefined) continue;
    const bucket = toolsByServer.get(tool.mcp_server_id) ?? [];
    bucket.push(toolDisplayName(tool.name));
    toolsByServer.set(tool.mcp_server_id, bucket);
  }

  const restart = async (serverId: string) => {
    setFeedback(null);
    try {
      await client.restartMcpServer(serverId);
      setFeedback({ tone: 'success', text: t('st.mcp.restartRequested') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  };

  return (
    <div className="min-w-0 space-y-2" data-mcp-view>
      {matchedWorkspace !== undefined && (trustQuery.data !== undefined || trustQuery.isError) ? (
        <div
          data-workspace-trust-strip
          className="flex items-center justify-between rounded-lg border border-hairline bg-ink/[0.03] px-3 py-2 text-[12px] text-ink"
        >
          {trustQuery.isError ? (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <InlineError error={trustQuery.error} />
              </div>
              <button
                type="button"
                disabled={trustQuery.isRefetching}
                onClick={() => { void trustQuery.refetch(); }}
                className="shrink-0 ml-3 font-medium underline hover:text-selected-ink focus-visible:outline-none"
              >
                {t('common.retry')}
              </button>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                    isTrusted ? 'bg-success' : 'bg-ink-faint'
                  }`}
                />
                <span className="truncate">
                  {isTrusted
                    ? t('st.mcp.workspaceTrustedNotice')
                    : t('st.mcp.workspaceUntrustedNotice')}
                </span>
              </div>
              <button
                type="button"
                disabled={trustBusy || trustQuery.isLoading || trustQuery.isError}
                onClick={() => { void toggleTrust(); }}
                className="shrink-0 ml-3 font-medium underline hover:text-selected-ink focus-visible:outline-none"
              >
                {isTrusted
                  ? t('st.mcp.revokeTrustAction')
                  : t('st.mcp.trustWorkspaceAction')}
              </button>
            </>
          )}
        </div>
      ) : null}
      <McpConfigManager
        cwd={cwd}
        entries={configQuery.data ?? []}
        loading={configQuery.isLoading}
        error={configQuery.error}
        onEcho={(servers) => { queryClient.setQueryData(['mcp-managed-servers', cwd], servers); }}
        runtime={{
          servers: runtimeQuery.data?.servers ?? [],
          toolsByServer,
          onRestart: restart,
        }}
      />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
