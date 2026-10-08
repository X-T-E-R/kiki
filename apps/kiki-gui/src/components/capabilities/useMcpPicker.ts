/**
 * The composer's MCP picker — this conversation's servers, and the switch that
 * is really this conversation's own.
 *
 * The engine answers through one port: `agent.listMcpSessionCapabilities()`
 * reports what each server is, where it was configured, whether it is connected
 * here, and whether *this* conversation overrode the configuration;
 * `agent.setMcpSessionOverride({ locator, override })` writes that override and
 * answers with the updated capability. Both carry redacted metadata only — a
 * locator, a runtime name, an origin, a config view, an auth state, a connection
 * state — so no `env`, `headers`, or credential reaches this process, and
 * nothing here needs a whole server config to switch a server on or off.
 *
 * Three rules, the same three the plugin picker earns its own code for:
 *
 * - **Nothing is sent.** A server is availability, not a prompt: no draft text,
 *   no message, no new conversation.
 * - **The answer is the engine's.** A refused write leaves the rows as the
 *   engine last described them and says what happened, rather than keeping a
 *   switch nobody's write moved.
 * - **A switch that cannot be written is not drawn.** A build whose klient has
 *   no session-override port yet still lists the conversation's servers, but it
 *   offers no override control: a toggle that fails every time is a worse lie
 *   than a row that explains itself.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Klient, McpServerEntry, McpServerLocator, McpSessionCapability } from '@kiki/klient';
import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import type { KikiClient } from '../../lib/client';
import { useConnection } from '../../state/connection';
import {
  mcpFallbackRows,
  mcpSessionRows,
  sameLocator,
  type McpOverride,
  type McpSessionRow,
} from './sessionMcp';

/**
 * How long the list keeps re-reading after a write. Switching a server on starts
 * a real connection, so the row would otherwise sit on its old answer while the
 * engine is already working.
 */
const CONNECTION_SETTLE_MS = 15_000;
const CONNECT_RECHECK_MS = 2_000;

/**
 * The session-scoped MCP surface, as this picker consumes it. The port is
 * `listMcpSessionCapabilities()` / `setMcpSessionOverride({ locator, override })`
 * from the typed `AgentFacade`; `getMcpServers()` and `reconnectMcpServer()` are
 * the reads and the retry that have always been here, and are used only where the
 * port is not. Both port methods stay optional in this shape: a connection to a
 * server that predates them must show up as a list this build cannot write, not
 * as a composer that fails to render.
 */
interface AgentMcpSurface {
  listMcpSessionCapabilities?: () => Promise<readonly McpSessionCapability[]>;
  setMcpSessionOverride?: (input: {
    readonly locator: McpServerLocator;
    readonly override: McpOverride;
  }) => Promise<McpSessionCapability>;
  getMcpServers?: () => Promise<readonly McpServerEntry[]>;
  reconnectMcpServer?: (name: string) => Promise<void>;
}

/** The port, from whatever the facade actually carries. */
export function mcpSessionPort(surface: AgentMcpSurface | undefined): {
  readonly list: () => Promise<readonly McpSessionCapability[]>;
  readonly write: (input: { locator: McpServerLocator; override: McpOverride }) => Promise<McpSessionCapability>;
} | undefined {
  if (typeof surface?.listMcpSessionCapabilities !== 'function') return undefined;
  if (typeof surface.setMcpSessionOverride !== 'function') return undefined;
  return {
    list: () => surface.listMcpSessionCapabilities!(),
    write: (input) => surface.setMcpSessionOverride!(input),
  };
}

/**
 * The agent facade's MCP surface, when this connection carries one.
 *
 * The read is written loosely on purpose: a connection object is the transport
 * boundary, and a host that cannot answer must show up as a list this build
 * cannot read — not as a composer that fails to render.
 */
function agentMcpSurface(client: KikiClient, sessionId: string | undefined): AgentMcpSurface | undefined {
  if (sessionId === undefined || sessionId === '') return undefined;
  const klient: Partial<Klient> | undefined = client.klient;
  const agent: unknown = klient?.session?.(sessionId)?.agent?.('main');
  return typeof agent === 'object' && agent !== null ? agent as AgentMcpSurface : undefined;
}

export type McpPickAction = 'switch' | 'restore' | 'retry';

/**
 * What the query holds: the port's own capabilities, or rows already built from
 * the reads a build without the port has.
 */
type McpRead =
  | { readonly kind: 'port'; readonly capabilities: readonly McpSessionCapability[] }
  | { readonly kind: 'reads'; readonly rows: readonly McpSessionRow[] };

/** Is anything in this answer still coming up, so the list keeps re-reading? */
function settling(data: McpRead | undefined): boolean {
  if (data === undefined) return false;
  if (data.kind === 'reads') return data.rows.some((row) => row.connection === 'connecting' || row.connection === 'enabled');
  return data.capabilities.some((capability) => capability.connection === 'connecting');
}

export interface McpPickFailure {
  /** The row whose write was refused. */
  readonly name: string;
  readonly message: string;
}

export function useMcpPicker(sessionId: string | undefined) {
  const { client } = useConnection();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<McpPickFailure | undefined>(undefined);
  const [busy, setBusy] = useState<{
    readonly name: string;
    readonly action: McpPickAction;
    /** The value a switch was just asked for, so the control shows the choice. */
    readonly on?: boolean;
  } | undefined>(undefined);
  const [settleUntil, setSettleUntil] = useState(0);
  // Read by a write that outlives this render, so a late failure is written in
  // the language the reader is actually looking at when it lands.
  const localeRef = useRef(locale);
  localeRef.current = locale;

  const scoped = sessionId !== undefined && sessionId !== '';
  const surface = useMemo(
    () => (scoped ? agentMcpSurface(client, sessionId) : undefined),
    [client, sessionId, scoped],
  );
  const port = useMemo(() => mcpSessionPort(surface), [surface]);
  const key = useMemo(() => ['session-mcp-capabilities', sessionId ?? 'none'] as const, [sessionId]);

  const read = useQuery({
    queryKey: key,
    queryFn: async (): Promise<McpRead> => {
      if (port !== undefined) return { kind: 'port', capabilities: await port.list() };
      if (surface?.getMcpServers === undefined) {
        throw new Error('this connection cannot read a conversation’s MCP servers');
      }
      // No port: the reads this GUI already has answer the same question minus
      // the override metadata, which is why those rows carry no switch.
      const [servers, catalog] = await Promise.all([
        surface.getMcpServers(),
        client.klient.global.mcp.list(),
      ]);
      return { kind: 'reads', rows: mcpFallbackRows({ servers, catalog }) };
    },
    enabled: scoped,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) => (Date.now() < settleUntil || settling(query.state.data) ? CONNECT_RECHECK_MS : false),
  });

  const items: readonly McpSessionRow[] = useMemo(() => {
    const data = read.data;
    if (data === undefined) return [];
    return data.kind === 'port'
      ? mcpSessionRows({ capabilities: data.capabilities, writable: true })
      : data.rows;
  }, [read.data]);

  const revalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['session-mcp-capabilities'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-managed-servers'] }),
      // The tools a server contributes are what the reader is really after.
      queryClient.invalidateQueries({ queryKey: ['tools'] }),
      queryClient.invalidateQueries({ queryKey: ['agentCapabilities'] }),
    ]);
  }, [queryClient]);

  const settle = useCallback(() => {
    setSettleUntil(Date.now() + CONNECTION_SETTLE_MS);
    void revalidate().catch(() => undefined);
  }, [revalidate]);

  const write = useMutation({
    mutationFn: async (input: { locator: McpServerLocator; override: McpOverride; name: string }) => {
      if (port === undefined) throw new Error('this build cannot write a conversation’s MCP servers');
      return port.write({ locator: input.locator, override: input.override });
    },
    onMutate: (input) => {
      setFailure(undefined);
      setBusy({
        name: input.name,
        action: input.override === 'inherit' ? 'restore' : 'switch',
        on: input.override !== 'off',
      });
    },
    onSuccess: (capability) => {
      // The engine's own updated capability replaces the row on screen, so what
      // the reader sees after a write is the state the engine recorded — and a
      // reopen of the menu re-reads it from the same source.
      queryClient.setQueryData<McpRead>(key, (current) =>
        current === undefined || current.kind !== 'port'
          ? current
          : {
              kind: 'port',
              capabilities: current.capabilities.map((row) =>
                sameLocator(row.locator, capability.locator) ? capability : row),
            });
      settle();
    },
    onError: (error, input) => {
      setFailure({ name: input.name, message: errorText(localeRef.current, error) });
    },
    onSettled: () => { setBusy(undefined); },
  });

  const reconnect = useMutation({
    mutationFn: async (input: { name: string }) => {
      if (surface?.reconnectMcpServer === undefined) {
        throw new Error('this build cannot reconnect a conversation’s MCP servers');
      }
      await surface.reconnectMcpServer(input.name);
    },
    onMutate: (input) => {
      setFailure(undefined);
      setBusy({ name: input.name, action: 'retry' });
    },
    onSuccess: () => { settle(); },
    onError: (error, input) => {
      setFailure({ name: input.name, message: errorText(localeRef.current, error) });
    },
    onSettled: () => { setBusy(undefined); },
  });

  return {
    items,
    /** False where this server has no conversation to scope a server to. */
    available: scoped,
    /** True where this build can really add, remove, and restore a server. */
    writable: port !== undefined,
    loading: scoped && read.isPending,
    failed: read.isError,
    failure,
    dismissFailure: useCallback(() => { setFailure(undefined); }, []),
    busyName: busy?.name,
    busyAction: busy?.action,
    busyOn: busy?.on,
    /** Add, remove, or return a server to the configuration — for this conversation only. */
    setOverride: useCallback((locator: McpServerLocator, override: McpOverride, name: string) => {
      write.mutate({ locator, override, name });
    }, [write]),
    /** Retry this conversation's connection to a server that failed or needs sign-in. */
    reconnect: useCallback((name: string) => { reconnect.mutate({ name }); }, [reconnect]),
    /** A list about to show re-reads, so an open menu is never yesterday's answer. */
    onShow: useCallback(() => {
      if (read.isStale && !read.isFetching) void read.refetch();
    }, [read]),
  };
}
