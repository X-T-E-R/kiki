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

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { toolDisplayName } from '../../lib/pluginCatalog';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { McpConfigManager } from '../settings/McpConfigManager';

export function McpView({ cwd }: { readonly cwd: string }) {
  const { client, klient } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<Feedback>(null);
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
