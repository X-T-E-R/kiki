/**
 * External clients: the GUI's view of the 0.3.3 contract.
 *
 * The wire types belong to `klient.rest.externalClients`, so they are imported
 * rather than restated: a field the facade does not carry cannot drift into
 * the UI behind the contract's back. This module adds only what the UI needs
 * on top of them:
 *
 * - a hook that hands back the facade, or `undefined` on a transport that has
 *   no HTTP REST surface, so a panel can say "not available here" instead of
 *   throwing deep inside a render;
 * - the session-page mark, read out of the untyped `metadata.custom` the
 *   session schema carries through;
 * - the tool template a new connection starts from.
 *
 * Nothing in here fabricates data. A server that does not serve the routes
 * produces a real failure, and every surface renders that failure.
 */

import type { Klient } from '@kiki/klient';
import type {
  ExternalClientAuthorization,
  ExternalClientConnection,
  ExternalClientListener,
  ExternalClientMaterial,
  ExternalClientMaterialsPreview,
  ExternalClientSession,
  ExternalClientTextInput,
  ExternalClientTextReceipt,
  ExternalTextKind,
  ExternalConnectionMode,
  ExternalConnectionPatch,
  ExternalHistoryScope,
  ExternalMemoryScope,
} from './externalClientTypes';

export type {
  ExternalClientAuthorization,
  ExternalClientConnection,
  ExternalClientListener,
  ExternalClientMaterial,
  ExternalClientMaterialsPreview,
  ExternalClientSession,
  ExternalClientTextReceipt,
  ExternalTextKind,
  ExternalConnectionMode,
  ExternalConnectionPatch,
  ExternalHistoryScope,
  ExternalMemoryScope,
};

/** The shape of `klient.rest`, narrowed to the one domain this feature uses. */
type ExternalClientsFacade = NonNullable<Klient['rest']>['externalClients'];

/**
 * The facade, or `undefined` when the connection has no HTTP REST surface
 * (memory and IPC transports). Panels treat that as "this server cannot do
 * that yet" rather than as a failed request.
 */
export function externalClientsFacade(klient: Klient | undefined): ExternalClientsFacade | undefined {
  return klient?.rest?.externalClients;
}

/** The mode a connection runs under, narrowed to what the composer offers. */
export function isPermissionMode(value: string): value is ExternalConnectionMode {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo';
}

/**
 * The facade reports timestamps as epoch milliseconds, while the GUI's time
 * formatters take ISO strings. Converting here keeps every other surface
 * writing the ISO it already writes, instead of re-formatting a number at
 * each call site.
 */
export function epochToIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function externalTextInput(
  text: string,
  kind: ExternalClientTextInput['kind'],
  idempotencyKey: string,
  title?: string,
): ExternalClientTextInput {
  return { text, kind, idempotencyKey, title };
}

/**
 * What a session page needs to know that it is externally driven.
 *
 * The engine persists the driver under `SessionMeta.custom.externalClient`,
 * but that is not the layer the GUI reads. kap-server projects the wire
 * `Session.metadata` by spreading `custom` flat, so the driver arrives as
 * `metadata.externalClient`. Both shapes are accepted because the flat one is
 * what a live server sends and the nested one is what the engine stores; a
 * session carrying neither renders as an ordinary one.
 */
export interface ExternalClientSessionMark {
  readonly driver: 'external';
  readonly connectionId: string;
  readonly clientName: string;
  readonly sessionRef: string;
}

function externalMarkOf(value: unknown): ExternalClientSessionMark | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<ExternalClientSessionMark>;
  if (candidate.driver !== 'external') return undefined;
  if (typeof candidate.connectionId !== 'string' || typeof candidate.clientName !== 'string'
    || typeof candidate.sessionRef !== 'string') return undefined;
  return {
    driver: 'external',
    connectionId: candidate.connectionId,
    clientName: candidate.clientName,
    sessionRef: candidate.sessionRef,
  };
}

export function readExternalClientMark(metadata: unknown): ExternalClientSessionMark | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const wire = metadata as { externalClient?: unknown; custom?: { externalClient?: unknown } };
  return externalMarkOf(wire.externalClient) ?? externalMarkOf(wire.custom?.externalClient);
}

/**
 * The tools a new connection can be granted, as the panel's template. File
 * reads and writes, media, Kiki's own sub agents and tasks, history, and the
 * save-text tool. Host commands are not in this list on purpose: running them
 * is a separate explicit grant, not one box among many.
 */
export const EXTERNAL_CLIENT_DEFAULT_TOOLS: readonly string[] = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit',
  'ReadMedia',
  'AgentRun', 'TaskList', 'TaskOutput', 'TaskStop',
  'HistoryList', 'HistoryRead', 'HistorySearch',
  'kiki_save_text',
];

/**
 * The listener's own state, in the order a person meets it: the port is bound,
 * then the address answers, then a remote client could complete the handshake.
 * A tunnel reporting ready is none of these, and the panel says so.
 */
export type ExternalListenerReadiness = 'off' | 'bound' | 'reachable' | 'unreachable' | 'failed';

export function listenerReadiness(listener: ExternalClientListener | undefined): ExternalListenerReadiness {
  if (listener === undefined || !listener.enabled) return 'off';
  if (listener.state === 'error') return 'failed';
  if (listener.state !== 'listening') return 'off';
  // The wire reports only `unchecked` today. A reachable or failed answer
  // would be a real probe this build does not run, so those states are kept
  // in the type for when it does and are never asserted today.
  if (listener.discovery === 'reachable') return 'reachable';
  if (listener.discovery === 'failed') return 'unreachable';
  return 'bound';
}

/** The sessions of a connection that are still open, newest first. */
export function openSessions(sessions: readonly ExternalClientSession[]): ExternalClientSession[] {
  return sessions.filter((session) => session.status === 'open')
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The material preview for one source session, cached so the settings row, the
 * composer and the disclosure read one answer. `null` means "not asked yet".
 */
const MATERIALS_QUERY_KEY = (sessionId: string) => ['external-clients', 'materials', sessionId] as const;

/** Whether the preview is the whole story; only a complete empty one is empty. */
export function materialsStateOf(
  preview: ExternalClientMaterialsPreview | undefined,
): 'ready' | 'partial' | 'unavailable' {
  if (preview === undefined) return 'unavailable';
  return preview.state === 'complete' ? 'ready' : 'partial';
}

/**
 * The app's own route to a session. Every surface that leaves an external
 * client for a session goes through here, because a path that misses
 * `/s/:id` does not fail — it falls through to the session list, so a branch
 * that was really created reads as though the click did nothing.
 */
export function sessionHref(sessionId: string): string {
  return `/s/${encodeURIComponent(sessionId)}`;
}
