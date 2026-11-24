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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import type { WorkspaceCatalogEntry } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { toolDisplayName } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { FeedbackLine, InlineError, type Feedback } from '../controls';
import { McpConfigManager } from '../settings/McpConfigManager';

export interface McpAddIntent {
  readonly id: number;
  readonly kind: 'new' | 'assist';
}

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

/** Catalog entries from the active connection; match the deepest directory, never a string prefix. */
export function findMcpWorkspace(cwd: string, workspaces: readonly WorkspaceCatalogEntry[]): WorkspaceCatalogEntry | undefined {
  const target = pathKey(cwd);
  if (target === undefined) return undefined;
  let matched: WorkspaceCatalogEntry | undefined;
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

export function McpView({
  cwd,
  addIntent,
  onConsumeAddIntent,
}: {
  readonly cwd: string;
  readonly addIntent?: McpAddIntent;
  readonly onConsumeAddIntent?: (id: number) => void;
}) {
  const { client, klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLDivElement>(null);
  const consumedIntentIdRef = useRef(0);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces', 'catalog'],
    queryFn: () => client.listWorkspaceCatalog(),
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

  const [optimisticTrusted, setOptimisticTrusted] = useState<boolean | undefined>(undefined);
  const isTrusted = optimisticTrusted ?? trustQuery.data?.trusted ?? false;

  const toggleTrust = async () => {
    if (!matchedWorkspace || trustBusy || trustQuery.data === undefined || trustQuery.isError) return;
    const nextTrusted = !isTrusted;
    setOptimisticTrusted(nextTrusted);
    setTrustBusy(true);
    setFeedback(null);
    try {
      const res = nextTrusted
        ? await client.trustWorkspace(matchedWorkspace.id)
        : await client.untrustWorkspace(matchedWorkspace.id);
      queryClient.setQueryData(['workspace-trust', matchedWorkspace.id], res);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-managed-servers', cwd] }),
        queryClient.invalidateQueries({ queryKey: ['tools', 'global'] }),
      ]);
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setOptimisticTrusted(undefined);
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

  const toolsByServer = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tool of toolsQuery.data?.tools ?? []) {
      if (tool.source !== 'mcp' || tool.mcp_server_id === undefined) continue;
      const bucket = map.get(tool.mcp_server_id) ?? [];
      bucket.push(toolDisplayName(tool.name));
      map.set(tool.mcp_server_id, bucket);
    }
    return map;
  }, [toolsQuery.data]);

  const restart = useCallback(async (serverId: string) => {
    setFeedback(null);
    try {
      await client.restartMcpServer(serverId);
      setFeedback({ tone: 'success', text: t('st.mcp.restartRequested') });
      await queryClient.invalidateQueries({ queryKey: ['mcp-servers'] });
    } catch (error) {
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    }
  }, [client, locale, queryClient, t]);

  const runtime = useMemo(() => ({
    servers: runtimeQuery.data?.servers ?? [],
    toolsByServer,
    onRestart: restart,
  }), [restart, runtimeQuery.data?.servers, toolsByServer]);

  useEffect(() => {
    if (addIntent === undefined || addIntent.id === consumedIntentIdRef.current || configQuery.isLoading) return;
    const selector = addIntent.kind === 'assist' ? '[data-mcp-ask-kiki]' : '[data-mcp-add]';
    const button = containerRef.current?.querySelector<HTMLButtonElement>(selector);
    if (button === null || button === undefined) return;
    consumedIntentIdRef.current = addIntent.id;
    if (!button.disabled) button.click();
    onConsumeAddIntent?.(addIntent.id);
  }, [addIntent, configQuery.isLoading, configQuery.data, onConsumeAddIntent]);

  return (
    <div ref={containerRef} className="min-w-0 space-y-3" data-mcp-view>
      {matchedWorkspace !== undefined && (trustQuery.data !== undefined || trustQuery.isError) ? (
        <div
          data-workspace-trust-strip
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg bg-ink/[0.03] px-3 py-2 text-[12px] text-ink"
        >
          {trustQuery.isError ? (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <InlineError error={trustQuery.error} />
              </div>
              <button
                type="button"
                disabled={trustQuery.isRefetching}
                onClick={() => { void trustQuery.refetch(); }}
                className="inline-flex min-h-7 shrink-0 items-center rounded px-1 font-medium text-ink underline-offset-2 hover:text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
              >
                {t('common.retry')}
              </button>
            </>
          ) : (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                    isTrusted ? 'bg-success' : 'bg-ink-faint'
                  }`}
                />
                <span className="min-w-0 leading-4">
                  {isTrusted
                    ? t('st.mcp.workspaceTrustedNotice')
                    : t('st.mcp.workspaceUntrustedNotice')}
                </span>
              </div>
              <button
                type="button"
                disabled={trustBusy || trustQuery.isLoading || trustQuery.isError}
                onClick={() => { void toggleTrust(); }}
                className="inline-flex min-h-7 shrink-0 items-center rounded px-1 font-medium text-ink underline-offset-2 hover:text-selected-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-selected-ink disabled:opacity-50 pointer-coarse:min-h-11"
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
        runtime={runtime}
      />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
