/**
 * A conversation's MCP servers — the pure rules behind the ＋ menu's list.
 *
 * The engine answers one question per server: what is it, which source
 * configured it, is it connected here, and did *this* conversation override the
 * configuration. Everything the menu draws comes from that answer, so a row can
 * never name a level the engine did not name:
 *
 * - `override` is this conversation's own decision. `on` is the reader adding a
 *   server here, `off` is a tombstone that removes it from this conversation and
 *   nowhere else, and `inherit` means the source decided.
 * - `connection` is the engine's live state, which is why a server the
 *   configuration turns off and a server this conversation removed can both read
 *   "off" while meaning two different things.
 *
 * The two offs must stay apart. "Turned off in the MCP configuration" is a fact
 * about every conversation; "Off for this conversation" is one the reader just
 * made and can reverse. A row that collapsed them would either hide a switch the
 * reader can use or offer one that would change more than they asked for. A
 * plugin that switches its own server off is a third case: the engine refuses to
 * admit it here, so the row names the plugin and draws no switch.
 *
 * `d5ab936c2` closed the engine side: `agent.listMcpSessionCapabilities()` and
 * `agent.setMcpSessionOverride({ locator, override })` are the port, and the
 * capability is already redacted — `config` arrives without `env` or `headers`,
 * and nothing else in it is a credential.
 */

import type { McpServerLocator, McpSessionCapability, McpSessionOverride } from '@kiki/klient';

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpConnection = McpSessionCapability['connection'];
export type McpAuthStatus = McpSessionCapability['authStatus'];
export type McpOverride = McpSessionOverride['override'];
export type McpOrigin = McpSessionCapability['origin'];

/** What the row is, in the menu's own terms. */
export type McpRowCondition =
  /** Admitted here and usable, or on its way up. */
  | 'live'
  /** Admitted, but still coming up. */
  | 'connecting'
  /** Admitted and its last attempt failed; the engine's error is on the row. */
  | 'failed'
  /** Admitted, waiting for the reader to sign in. */
  | 'signed-out'
  /** This conversation added it, overriding a source that had it off. */
  | 'on-here'
  /** This conversation removed it; its source still has it. */
  | 'off-here'
  /** Its source turns it off and this conversation did not override. */
  | 'off-config'
  /** A plugin turns its own server off, so the engine will not admit it here. */
  | 'plugin-off'
  /** Its source is gone, or another source owns the runtime name. */
  | 'unavailable';

export interface McpSessionRow {
  /** The runtime name; unique inside one conversation's list. */
  readonly name: string;
  readonly transport: McpTransport;
  readonly condition: McpRowCondition;
  readonly connection: McpConnection;
  readonly authStatus: McpAuthStatus;
  /** The level that configured it, in the engine's own vocabulary. */
  readonly origin: McpOrigin;
  /** The plugin an origin of `plugin` points at, in the words the read had. */
  readonly pluginLabel?: string;
  /** Whether the source configuration itself enables this entry. */
  readonly configEnabled: boolean;
  readonly override: McpOverride;
  readonly error?: string;
  readonly locator?: McpServerLocator;
  /**
   * True when a write can be addressed and shown: the engine named a locator for
   * this row, this build has the session-override port, and the engine would
   * accept the write. A switch that cannot be written is the one control this
   * menu must not draw.
   */
  readonly addressable: boolean;
  /** Retry is offered only where the engine holds a connection worth retrying. */
  readonly canReconnect: boolean;
  /** True where the way back to the source baseline is a real choice. */
  readonly canRestore: boolean;
}

/** Everything the row rules read. Both the port and the fallback reads fill it. */
interface RowSource {
  readonly runtimeName: string;
  readonly locator?: McpServerLocator;
  readonly origin: McpOrigin;
  readonly pluginLabel?: string;
  readonly transport: string | undefined;
  readonly configEnabled: boolean;
  readonly authStatus: McpAuthStatus;
  readonly connection: string;
  readonly override: McpOverride;
  readonly error?: string;
}

const TRANSPORTS: readonly string[] = ['stdio', 'http', 'sse'];
const CONNECTIONS: readonly string[] = ['enabled', 'disabled', 'connecting', 'connected', 'failed', 'unavailable'];

function transportOf(value: string | undefined): McpTransport {
  return value !== undefined && TRANSPORTS.includes(value) ? value as McpTransport : 'stdio';
}

function connectionOf(value: string): McpConnection {
  return CONNECTIONS.includes(value) ? value as McpConnection : 'unavailable';
}

/**
 * Which condition the row is in. The conversation's own override leads, because
 * it is what this reader chose and can change here; only where nothing was
 * overridden do the source and the live connection answer.
 */
export function rowCondition(source: RowSource): McpRowCondition {
  if (source.override === 'off') return 'off-here';
  if (source.override === 'on') return 'on-here';
  if (source.connection === 'disabled') return source.origin === 'plugin' ? 'plugin-off' : 'off-config';
  if (source.authStatus === 'oauth-required' || source.authStatus === 'oauth-expired') return 'signed-out';
  if (source.connection === 'connected') return 'live';
  if (source.connection === 'connecting') return 'connecting';
  if (source.connection === 'failed') return 'failed';
  if (source.connection === 'enabled') return 'live';
  return 'unavailable';
}

/** Is this server part of the conversation right now? */
export function heldByConversation(row: McpSessionRow): boolean {
  return row.condition !== 'off-here'
    && row.condition !== 'off-config'
    && row.condition !== 'plugin-off'
    && row.condition !== 'unavailable';
}

/** The count the Session group shows: how many servers this conversation holds. */
export function heldCount(rows: readonly McpSessionRow[]): number {
  return rows.reduce((count, row) => (heldByConversation(row) ? count + 1 : count), 0);
}

/** The row's search text: the server, its source, and its transport. */
export function mcpRowMatches(row: McpSessionRow, query: string): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return [row.name, row.origin, row.pluginLabel ?? '', row.transport].some((field) => field.toLowerCase().includes(needle));
}

/** Do two locators name the same server? Unknown on either side is not a match. */
export function sameLocator(left: McpServerLocator | undefined, right: McpServerLocator | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (left.source === 'global') {
    return right.source === 'global' && right.name === left.name;
  }
  return right.source === 'plugin' && right.pluginId === left.pluginId && right.serverName === left.serverName;
}

/**
 * The rows the engine's session capabilities describe.
 *
 * `writable` is this build's answer to whether the write port exists at all. The
 * engine's own refusals are narrower than that: a plugin that disables its own
 * server rejects `on`, and a locator whose source is gone has nothing new to
 * decide. Those rows still offer the way back to the source baseline when the
 * reader had overridden them, and never a switch that would fail.
 */
export function mcpSessionRows(input: {
  readonly capabilities: readonly McpSessionCapability[];
  readonly writable: boolean;
}): readonly McpSessionRow[] {
  return input.capabilities.map((capability) => rowsFrom({
    runtimeName: capability.runtimeName,
    locator: capability.locator,
    origin: capability.origin,
    pluginLabel: capability.locator.source === 'plugin' ? capability.locator.pluginId : undefined,
    transport: capability.config.transport,
    configEnabled: capability.config.enabled !== false,
    authStatus: capability.authStatus,
    connection: capability.connection,
    override: capability.override,
    error: capability.error,
  }, input.writable));
}

/**
 * The same rows from the reads this build already has, for a build whose klient
 * has no session-override port.
 *
 * A conversation's live entries carry the connection and the error; the
 * management catalog names the level that configured each one and whether its
 * configuration enables it. Neither carries the session override, and this
 * function must not invent one: an override this build did not read would be a
 * caption about a decision nobody made. Rows built this way are therefore never
 * addressable, and a tombstone — which only the port can explain — is left out
 * rather than labelled with the wrong off.
 */
export function mcpFallbackRows(input: {
  readonly servers: readonly { readonly name: string; readonly transport: string; readonly status: string; readonly error?: string }[];
  readonly catalog: readonly {
    readonly name: string;
    readonly source: string;
    /** The level in the catalog's own words, for the plugin that owns an entry. */
    readonly origin?: string;
    readonly config: { readonly transport: string; readonly enabled?: boolean };
  }[];
}): readonly McpSessionRow[] {
  const catalog = new Map(input.catalog.map((entry) => [entry.name, entry]));
  return input.servers
    .filter((server) => server.status !== 'removed')
    .map((server) => {
      const configured = catalog.get(server.name);
      const plugin = configured?.source === 'plugin';
      return rowsFrom({
        runtimeName: server.name,
        // Only a global entry can be addressed by name alone; a plugin's server is
        // addressed by its manifest, which this read does not report.
        locator: configured?.source === 'global' ? { source: 'global' as const, name: server.name } : undefined,
        origin: plugin ? 'plugin' : 'global',
        pluginLabel: plugin ? configured?.origin : undefined,
        transport: TRANSPORTS.includes(server.transport) ? server.transport : configured?.config.transport,
        configEnabled: configured?.config.enabled !== false,
        // The runtime list has its own words for the same states; the capability
        // vocabulary is the one the rows and the write path both speak.
        authStatus: server.status === 'needs-auth' ? 'oauth-required' : 'unavailable',
        connection: runtimeConnection(server.status),
        override: 'inherit',
        error: server.error,
      }, false);
    });
}

/** The runtime entry's own status word, in the capability vocabulary. */
function runtimeConnection(status: string): McpConnection {
  if (status === 'pending') return 'connecting';
  if (status === 'needs-auth') return 'failed';
  if (status === 'connected' || status === 'disabled' || status === 'failed') return status;
  return 'unavailable';
}

function rowsFrom(source: RowSource, writable: boolean): McpSessionRow {
  const condition = rowCondition(source);
  const locator = source.locator;
  const addressable = writable
    && locator !== undefined
    && condition !== 'plugin-off'
    && condition !== 'unavailable';
  return {
    name: source.runtimeName,
    transport: transportOf(source.transport),
    condition,
    connection: connectionOf(source.connection),
    authStatus: source.authStatus,
    origin: source.origin,
    pluginLabel: source.pluginLabel,
    configEnabled: source.configEnabled,
    override: source.override,
    error: source.error === undefined || source.error === '' ? undefined : source.error,
    locator,
    addressable,
    canReconnect: source.connection === 'failed' && source.override !== 'off',
    canRestore: source.override !== 'inherit' && locator !== undefined && writable,
  };
}

/**
 * A switch changes this conversation's decision. Returning to the source
 * baseline is a separate action, shown as Use config on rows with an override.
 */
export function overrideForSwitch(_row: McpSessionRow, on: boolean): McpOverride {
  return on ? 'on' : 'off';
}
