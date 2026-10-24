/**
 * Which saved browsers the Agent may use, and which one it picks first. Two
 * different facts, kept apart on purpose:
 *
 *   allowed   the connection is switched on and, once the allow list has been
 *             written, named in it. Its source switch must also be on before
 *             the server counts it.
 *   default   the one connection a call lands on when it names none. Being the
 *             default does not make a connection allowed.
 *
 * The source a connection belongs to is the server's own attribution
 * (`browserSourceOfConnectionType`), not the route that happens to list it:
 * a record stored as CDP under the bridge's id still answers to the bridge's
 * source switch.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  browserSourceOfConnectionType,
  effectiveAllowedBrowserCount,
  isBrowserConnectionEffectiveAllowed,
  isBrowserToolPolicyDenied,
  isBrowserToolPolicyPartiallyDenied,
  type BrowserSourceId,
} from '@kiki/session-core/settings';

import type { KikiConfigPatch } from '../../../lib/client';
import { browserApi, browserKeys, type BrowserConnectionRow } from '../../../lib/browserRest';
import { useConnection } from '../../../state/connection';

type ControlFields = {
  readonly allowedBrowsers?: string[];
  readonly allowedBrowsersConfigured?: boolean;
  readonly disabledSources?: string[];
};

export function useBrowserAllowance() {
  const { client, scopeId } = useConnection();
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['config', scopeId],
    queryFn: () => client.getConfig(),
    staleTime: 30_000,
  });
  const connectionsQuery = useQuery({
    queryKey: browserKeys.connections(scopeId),
    queryFn: () => browserApi(client).list(),
    staleTime: 10_000,
  });

  const listed = connectionsQuery.data as (ControlFields & { readonly connections: readonly BrowserConnectionRow[] }) | undefined;
  const stored = (configQuery.data as { browser_control?: ControlFields } | undefined)?.browser_control;
  const connections: readonly BrowserConnectionRow[] = listed?.connections ?? [];
  const defaultBrowser = connectionsQuery.data?.defaultBrowser ?? '';
  const allowedBrowsers = listed?.allowedBrowsers ?? stored?.allowedBrowsers;
  const allowedConfigured = listed?.allowedBrowsersConfigured === true || stored?.allowedBrowsersConfigured === true;
  const disabledSources: readonly string[] = listed?.disabledSources ?? stored?.disabledSources ?? [];
  const toolPolicyDenied = isBrowserToolPolicyDenied(configQuery.data);
  const toolPolicyPartial = isBrowserToolPolicyPartiallyDenied(configQuery.data);

  const sourceOf = (connection: Pick<BrowserConnectionRow, 'id' | 'type'>): BrowserSourceId | undefined =>
    browserSourceOfConnectionType(connection.type, connection.id);

  const sourceEnabled = (source: string | undefined): boolean => source === undefined || !disabledSources.includes(source);

  /** The stored choice, before the source switch is applied. */
  const isChosen = (connection: { readonly id: string; readonly enabled?: boolean } | undefined): boolean => {
    if (connection === undefined || connection.enabled === false) return false;
    if (allowedConfigured && allowedBrowsers !== undefined) return allowedBrowsers.includes(connection.id);
    return true;
  };

  /** What the server actually lets the Agent use right now. */
  const isEffective = (connection: BrowserConnectionRow): boolean =>
    isBrowserConnectionEffectiveAllowed(connection, allowedConfigured, allowedBrowsers, disabledSources);

  const effectiveCount = effectiveAllowedBrowserCount(connections, allowedConfigured, allowedBrowsers, disabledSources);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
    await queryClient.invalidateQueries({ queryKey: browserKeys.presets(scopeId) });
    await queryClient.invalidateQueries({ queryKey: ['config', scopeId] });
  };

  /**
   * Rewrites a connection with only its switch changed. Each type is written
   * in its own shape, so an extension binding or a CDP address is carried as
   * stored rather than re-serialised under another branch.
   */
  const writeEnabled = async (existing: BrowserConnectionRow, nextEnabled: boolean, fallbackBrowserId?: string) => {
    const api = browserApi(client);
    if (existing.type === 'agent-browser-profile') {
      await api.upsert(existing.id, {
        type: 'agent-browser-profile', name: existing.name, enabled: nextEnabled,
        profilePath: existing.profilePath, executablePath: existing.executablePath, headed: existing.headed, driverPath: existing.driverPath,
      });
    } else if (existing.type === 'agent-browser-cdp') {
      await api.upsert(existing.id, {
        type: 'agent-browser-cdp', name: existing.name, enabled: nextEnabled, endpoint: { action: 'keep' }, driverPath: existing.driverPath,
      });
    } else if (existing.type === 'kimi-webbridge') {
      await api.upsert(existing.id, { type: 'kimi-webbridge', name: existing.name, enabled: nextEnabled, driverPath: existing.driverPath });
    } else if (existing.type === 'codex-extension') {
      await api.upsert(existing.id, {
        type: 'codex-extension', name: existing.name, enabled: nextEnabled,
        runtimeRoot: existing.runtimeRoot ?? '', browserId: existing.browserId ?? fallbackBrowserId ?? existing.id,
      });
    } else if (existing.type === 'ego-lite') {
      await api.upsert(existing.id, {
        type: 'ego-lite', name: existing.name, enabled: nextEnabled,
        ...(existing.cliPath !== undefined ? { cliPath: existing.cliPath } : {}),
        ...(existing.profileId !== undefined ? { profileId: existing.profileId } : {}),
        ...(existing.serverName !== undefined ? { serverName: existing.serverName } : {}),
      });
    }
  };

  /**
   * Writes the allow list with this id added or removed, then lines the
   * connection's own switch up with it. The first write of an unconfigured list
   * starts from what is allowed today, so ticking one box never silently drops
   * the others. Ids the store does not know are not carried forward.
   */
  const writeAllowed = async (connectionId: string, nextChecked: boolean, options: {
    readonly fallbackBrowserId?: string;
    /** A connection created a moment ago, not yet in the list this hook read. */
    readonly justCreated?: boolean;
  } = {}) => {
    const known = new Set(connections.map((connection) => connection.id));
    if (options.justCreated === true) known.add(connectionId);
    const base = (allowedConfigured && allowedBrowsers !== undefined
      ? [...allowedBrowsers]
      : connections.filter((connection) => connection.enabled).map((connection) => connection.id))
      .filter((id) => known.has(id));
    const nextAllowed = nextChecked ? [...new Set([...base, connectionId])] : base.filter((id) => id !== connectionId);
    await client.patchConfig({ browser_control: { allowed_browsers: nextAllowed } } as KikiConfigPatch);
    const existing = connections.find((connection) => connection.id === connectionId);
    if (existing !== undefined && existing.enabled !== nextChecked) await writeEnabled(existing, nextChecked, options.fallbackBrowserId);
    await invalidate();
  };

  /** Pressing the current default clears it; any other id becomes the default. */
  const writeDefault = async (connectionId: string, isDefault: boolean) => {
    await browserApi(client).setDefault(isDefault ? undefined : connectionId);
    await queryClient.invalidateQueries({ queryKey: browserKeys.connections(scopeId) });
  };

  /**
   * Turns one source off or back on. Turning a source off first pins today's
   * allow list when none was written yet, so the boxes under it come back
   * exactly as they were when the source returns.
   */
  const writeSourceEnabled = async (source: BrowserSourceId, nextEnabled: boolean) => {
    if (!nextEnabled) {
      const preserved = allowedConfigured && allowedBrowsers !== undefined
        ? [...allowedBrowsers]
        : connections.filter((connection) => connection.enabled).map((connection) => connection.id);
      const nextDisabled = [...new Set([...disabledSources, source])] as BrowserSourceId[];
      await client.patchConfig({
        browser_control: { disabled_sources: nextDisabled, ...(!allowedConfigured ? { allowed_browsers: preserved } : {}) },
      } as KikiConfigPatch);
    } else {
      const nextDisabled = disabledSources.filter((item) => item !== source) as BrowserSourceId[];
      await client.patchConfig({ browser_control: { disabled_sources: nextDisabled } } as KikiConfigPatch);
    }
    await invalidate();
  };

  return {
    configQuery, connectionsQuery, connections, defaultBrowser, disabledSources, toolPolicyDenied, toolPolicyPartial,
    sourceOf, sourceEnabled, isChosen, isEffective, effectiveCount,
    writeAllowed, writeDefault, writeSourceEnabled, invalidate,
  };
}

export type BrowserAllowance = ReturnType<typeof useBrowserAllowance>;
