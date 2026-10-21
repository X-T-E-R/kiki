/**
 * Choices made on /new before a conversation exists.
 *
 * They stay in this module, not on a session and not in global settings:
 * creating an empty conversation just to hold a switch would be a conversation
 * the reader did not ask for. Untouched rows are absent, so inherit still
 * means the workspace and the global default.
 *
 * Each connection draft has its own bucket. Callers that have not bound a
 * draft keep using the default bucket, which is what an apply without a scope
 * writes. A successful apply removes only the revisions it captured. A choice
 * made while that write is in flight stays. A failed apply leaves the bucket
 * untouched. This function never creates a conversation.
 */

import type { McpServerLocator } from '@kiki/klient';
import type { PluginUsageRequest } from '@kiki/protocol';

import { sameLocator, type McpOverride } from './sessionMcp';

export interface PendingPluginChoice {
  readonly pluginId: string;
  readonly override: 'on' | 'off';
}

export interface PendingMcpChoice {
  readonly locator: McpServerLocator;
  readonly override: McpOverride;
  readonly name: string;
}

export type PendingOptionalCapabilityId = 'browser' | 'computer' | 'memory' | 'thread' | 'web';

export interface PendingOptionalChoice {
  readonly id: PendingOptionalCapabilityId;
  readonly choice: 'on' | 'off';
}

export interface PendingNewSessionCapabilities {
  readonly plugins: readonly PendingPluginChoice[];
  readonly mcp: readonly PendingMcpChoice[];
  readonly optional?: readonly PendingOptionalChoice[];
}

/** The connection and the /new draft those choices belong to. */
export interface PendingCapabilityScope {
  readonly scopeId: string;
  readonly spaceKey: string;
  readonly connectionId: string | null;
  readonly draftKey: string;
}

const EMPTY: PendingNewSessionCapabilities = { plugins: [], mcp: [] };

const DEFAULT_SCOPE: PendingCapabilityScope = {
  scopeId: '',
  spaceKey: '',
  connectionId: null,
  draftKey: '',
};

interface StampedPlugin extends PendingPluginChoice {
  readonly revision: number;
}

interface StampedMcp extends PendingMcpChoice {
  readonly revision: number;
}

interface StampedOptional extends PendingOptionalChoice {
  readonly revision: number;
}

interface Bucket {
  plugins: StampedPlugin[];
  mcp: StampedMcp[];
  optional: StampedOptional[];
  snapshot: PendingNewSessionCapabilities;
}

let revisionClock = 0;
const buckets = new Map<string, Bucket>();
const bindings = new Map<string, PendingCapabilityScope>();
const listeners = new Set<() => void>();

function connectionIdentity(scope: Pick<PendingCapabilityScope, 'scopeId' | 'spaceKey' | 'connectionId'>): string {
  return `${scope.scopeId}\0${scope.spaceKey}\0${scope.connectionId ?? ''}`;
}

/** Bucket identity: one connection, one draft. */
export function pendingCapabilityConnectionKey(scope: PendingCapabilityScope): string {
  return `${connectionIdentity(scope)}\0${scope.draftKey}`;
}

function sameScope(left: PendingCapabilityScope, right: PendingCapabilityScope): boolean {
  return left.scopeId === right.scopeId
    && left.spaceKey === right.spaceKey
    && left.connectionId === right.connectionId
    && left.draftKey === right.draftKey;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(key: string, bucket: Bucket): void {
  if (bucket.plugins.length === 0 && bucket.mcp.length === 0 && bucket.optional.length === 0) {
    buckets.delete(key);
    notify();
    return;
  }
  const optional = bucket.optional.map(({ id, choice }) => ({ id, choice }));
  bucket.snapshot = {
    plugins: bucket.plugins.map(({ pluginId, override }) => ({ pluginId, override })),
    mcp: bucket.mcp.map(({ locator, override, name }) => ({ locator, override, name })),
    ...(optional.length > 0 ? { optional } : {}),
  };
  buckets.set(key, bucket);
  notify();
}

function bucketOf(scope: PendingCapabilityScope): Bucket {
  const key = pendingCapabilityConnectionKey(scope);
  let bucket = buckets.get(key);
  if (bucket === undefined) {
    bucket = { plugins: [], mcp: [], optional: [], snapshot: EMPTY };
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * Remember which draft this connection's /new page is editing.
 * Unchanged input does nothing, so calling it during render does not notify.
 */
export function bindPendingNewSessionDraft(scope: PendingCapabilityScope): void {
  const key = connectionIdentity(scope);
  const current = bindings.get(key);
  if (current !== undefined && sameScope(current, scope)) return;
  bindings.set(key, scope);
}

/** The draft bound for this connection, or the default bucket when none is. */
export function currentPendingCapabilityScope(
  connection: Pick<PendingCapabilityScope, 'scopeId' | 'spaceKey' | 'connectionId'>,
): PendingCapabilityScope {
  return bindings.get(connectionIdentity({
    scopeId: connection.scopeId ?? '',
    spaceKey: connection.spaceKey ?? '',
    connectionId: connection.connectionId ?? null,
  })) ?? DEFAULT_SCOPE;
}

export function subscribePendingNewSessionCapabilities(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function pendingNewSessionCapabilities(scope: PendingCapabilityScope = DEFAULT_SCOPE): PendingNewSessionCapabilities {
  return buckets.get(pendingCapabilityConnectionKey(scope))?.snapshot ?? EMPTY;
}

export function setPendingPluginChoice(
  pluginId: string,
  override: 'on' | 'off' | 'inherit',
  scope: PendingCapabilityScope = DEFAULT_SCOPE,
): void {
  const key = pendingCapabilityConnectionKey(scope);
  const bucket = bucketOf(scope);
  bucket.plugins = bucket.plugins.filter((item) => item.pluginId !== pluginId);
  if (override !== 'inherit') {
    revisionClock += 1;
    bucket.plugins = [...bucket.plugins, { pluginId, override, revision: revisionClock }];
  }
  publish(key, bucket);
}

export function setPendingOptionalChoice(
  id: PendingOptionalCapabilityId,
  choice: 'on' | 'off' | 'inherit',
  scope: PendingCapabilityScope = DEFAULT_SCOPE,
): void {
  const key = pendingCapabilityConnectionKey(scope);
  const bucket = bucketOf(scope);
  bucket.optional = bucket.optional.filter((item) => item.id !== id);
  if (choice !== 'inherit') {
    revisionClock += 1;
    bucket.optional = [...bucket.optional, { id, choice, revision: revisionClock }];
  }
  publish(key, bucket);
}

export function setPendingMcpChoice(
  choice: PendingMcpChoice | { readonly locator: McpServerLocator; readonly override: 'inherit'; readonly name: string },
  scope: PendingCapabilityScope = DEFAULT_SCOPE,
): void {
  const key = pendingCapabilityConnectionKey(scope);
  const bucket = bucketOf(scope);
  bucket.mcp = bucket.mcp.filter((item) => !sameLocator(item.locator, choice.locator));
  if (choice.override !== 'inherit') {
    revisionClock += 1;
    bucket.mcp = [...bucket.mcp, { locator: choice.locator, override: choice.override, name: choice.name, revision: revisionClock }];
  }
  publish(key, bucket);
}

/** Drop every draft. Tests use this so a bucket cannot leak into the next case. */
export function clearPendingNewSessionCapabilities(): void {
  if (buckets.size === 0 && bindings.size === 0) return;
  buckets.clear();
  bindings.clear();
  notify();
}

export interface PendingCapabilityClient {
  setPluginUsage(input: PluginUsageRequest): Promise<unknown>;
  setOptionalCapability?(input: { readonly sessionId: string; readonly id: PendingOptionalCapabilityId; readonly choice: 'on' | 'off' }): Promise<unknown>;
  klient: {
    session(id: string): {
      agent(id: string): {
        setMcpSessionOverride(input: { readonly locator: McpServerLocator; readonly override: McpOverride }): Promise<unknown>;
      };
    };
  };
}

/**
 * Write one draft's captured choices onto a conversation that already exists.
 *
 * The scope is the draft that was submitted, not whichever draft is bound
 * when the write finishes. Plugin usage is first: an MCP override creates
 * the agent, and that create registers tools from the usage already stored.
 * Only the captured revisions are removed, and only after every write from
 * that capture has been accepted.
 */
export async function applyPendingNewSessionCapabilities(
  client: PendingCapabilityClient,
  sessionId: string,
  scope: PendingCapabilityScope = DEFAULT_SCOPE,
): Promise<void> {
  const key = pendingCapabilityConnectionKey(scope);
  const bucket = buckets.get(key);
  const plugins = bucket?.plugins.map((item) => ({ ...item })) ?? [];
  const optional = bucket?.optional.map((item) => ({ ...item })) ?? [];
  const mcp = bucket?.mcp.map((item) => ({ ...item })) ?? [];
  for (const choice of plugins) {
    await client.setPluginUsage({ target: { session_id: sessionId }, plugin_id: choice.pluginId, override: choice.override });
  }
  if (optional.length > 0) {
    if (client.setOptionalCapability === undefined) throw new Error('this connection cannot store optional capabilities');
    for (const choice of optional) {
      await client.setOptionalCapability({ sessionId, id: choice.id, choice: choice.choice });
    }
  }
  if (mcp.length > 0) {
    const agent = client.klient.session(sessionId).agent('main');
    for (const choice of mcp) {
      await agent.setMcpSessionOverride({ locator: choice.locator, override: choice.override });
    }
  }
  const current = buckets.get(key);
  if (current === undefined) return;
  const pluginRevision = new Map(plugins.map((item) => [item.pluginId, item.revision]));
  const optionalRevision = new Map(optional.map((item) => [item.id, item.revision]));
  current.plugins = current.plugins.filter((item) => pluginRevision.get(item.pluginId) !== item.revision);
  current.optional = current.optional.filter((item) => optionalRevision.get(item.id) !== item.revision);
  current.mcp = current.mcp.filter((item) => {
    const captured = mcp.find((candidate) => sameLocator(candidate.locator, item.locator));
    return captured === undefined || captured.revision !== item.revision;
  });
  publish(key, current);
}
