/**
 * External clients: the GUI's view of the 0.3.3 contract.
 *
 * This module provides UI helpers on top of the external-client types:
 * - a hook that hands back the facade, or undefined on a transport that has
 *   no HTTP REST surface;
 * - the session-page mark, read out of metadata.custom or metadata.externalClient;
 * - the tool template a new connection starts from;
 * - listener readiness states and session route links.
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
  ExternalClientsFacade,
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
  ExternalClientsFacade,
  ExternalTextKind,
  ExternalConnectionMode,
  ExternalConnectionPatch,
  ExternalHistoryScope,
  ExternalMemoryScope,
};

/**
 * The facade, or undefined when the connection has no HTTP REST surface.
 */
export function externalClientsFacade(klient: Klient | undefined): ExternalClientsFacade | undefined {
  return (klient?.rest as unknown as { externalClients?: ExternalClientsFacade })?.externalClients;
}

/** The mode a connection runs under, narrowed to what the composer offers. */
export function isPermissionMode(value: string): value is ExternalConnectionMode {
  return value === 'manual' || value === 'auto' || value === 'review' || value === 'yolo';
}

/**
 * The facade reports timestamps as epoch milliseconds, while the GUI's time
 * formatters take ISO strings.
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
  if (
    typeof candidate.connectionId !== 'string' ||
    typeof candidate.clientName !== 'string' ||
    typeof candidate.sessionRef !== 'string'
  )
    return undefined;
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
 * Tools granted by default to a new connection.
 */
export const EXTERNAL_CLIENT_DEFAULT_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'ReadMedia',
  'AgentRun',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'HistoryList',
  'HistoryRead',
  'HistorySearch',
  'kiki_save_text',
];

export type ExternalListenerReadiness = 'off' | 'bound' | 'reachable' | 'unreachable' | 'failed';

export function listenerReadiness(listener: ExternalClientListener | undefined): ExternalListenerReadiness {
  if (listener === undefined || !listener.enabled) return 'off';
  if (listener.state === 'error') return 'failed';
  if (listener.state !== 'listening') return 'off';
  if (listener.discovery === 'reachable') return 'reachable';
  if (listener.discovery === 'failed') return 'unreachable';
  return 'bound';
}

/** The sessions of a connection that are still open, newest first. */
export function openSessions(sessions: readonly ExternalClientSession[]): ExternalClientSession[] {
  return sessions
    .filter((session) => session.status === 'open')
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

/** Whether the preview is the whole story; only a complete empty one is empty. */
export function materialsStateOf(
  preview: ExternalClientMaterialsPreview | undefined,
): 'ready' | 'partial' | 'unavailable' {
  if (preview === undefined) return 'unavailable';
  return preview.state === 'complete' ? 'ready' : 'partial';
}

/**
 * Route to a session.
 */
export function sessionHref(sessionId: string): string {
  return `/s/${encodeURIComponent(sessionId)}`;
}
