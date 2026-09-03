import type { EventSourceRef, ScopeRef } from '../core/channel.js';
import { RPCError } from '../core/errors.js';

export type TransportScope = 'core' | 'workspace' | 'session' | 'agent';

export interface KlientTarget {
  readonly scope?: string;
  readonly service?: string;
  readonly method?: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly event?: string;
}

export interface KlientProcedure extends KlientTarget {
  readonly scope: TransportScope;
  readonly service: string;
  readonly method: string;
}

export interface KlientCallRequest {
  readonly procedure: KlientProcedure;
  readonly params: unknown[];
}

export interface KlientFrame extends KlientTarget {
  readonly type: string;
  readonly id?: string;
  readonly arg?: unknown;
  readonly token?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly details?: unknown;
  readonly reason?: string;
  readonly data?: unknown;
}

const REQUEST_INVALID = 40001;

export function isTransportScope(value: unknown): value is TransportScope {
  return value === 'core' || value === 'workspace' || value === 'session' || value === 'agent';
}

export function scopeKindOf(scope: ScopeRef): TransportScope {
  if (scope.agentId !== undefined) return 'agent';
  if (scope.sessionId !== undefined) return 'session';
  if (scope.workspaceId !== undefined) return 'workspace';
  return 'core';
}

export function createProcedure(
  scope: ScopeRef,
  service: string,
  method: string,
): KlientProcedure {
  return {
    scope: scopeKindOf(scope),
    service,
    method,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    agentId: scope.agentId,
  };
}

export function parseKlientCallRequest(value: unknown): KlientCallRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RPCError(REQUEST_INVALID, 'invalid klient call body');
  }
  const body = value as Record<string, unknown>;
  const rawProcedure = body['procedure'];
  if (rawProcedure === null || typeof rawProcedure !== 'object' || Array.isArray(rawProcedure)) {
    throw new RPCError(REQUEST_INVALID, 'invalid klient procedure');
  }
  const procedure = rawProcedure as Record<string, unknown>;
  const scope = procedure['scope'];
  const service = procedure['service'];
  const method = procedure['method'];
  if (!isTransportScope(scope)) {
    throw new RPCError(REQUEST_INVALID, 'invalid klient procedure scope');
  }
  if (typeof service !== 'string' || service.length === 0) {
    throw new RPCError(REQUEST_INVALID, 'invalid klient procedure service');
  }
  if (typeof method !== 'string' || method.length === 0) {
    throw new RPCError(REQUEST_INVALID, 'invalid klient procedure method');
  }
  const workspaceId = optionalString(procedure['workspaceId'], 'workspaceId');
  const sessionId = optionalString(procedure['sessionId'], 'sessionId');
  const agentId = optionalString(procedure['agentId'], 'agentId');
  if (scope === 'workspace' && workspaceId === undefined) {
    throw new RPCError(REQUEST_INVALID, 'workspace procedure requires workspaceId');
  }
  if ((scope === 'session' || scope === 'agent') && sessionId === undefined) {
    throw new RPCError(REQUEST_INVALID, `${scope} procedure requires sessionId`);
  }
  if (scope === 'agent' && agentId === undefined) {
    throw new RPCError(REQUEST_INVALID, 'agent procedure requires agentId');
  }
  if (!Array.isArray(body['params'])) {
    throw new RPCError(REQUEST_INVALID, 'klient call params must be an array');
  }
  return {
    procedure: { scope, service, method, workspaceId, sessionId, agentId },
    params: body['params'],
  };
}

export function scopeRefFromTarget(target: KlientTarget): ScopeRef {
  const scope: { workspaceId?: string; sessionId?: string; agentId?: string } = {};
  if (typeof target.workspaceId === 'string') scope.workspaceId = target.workspaceId;
  if (typeof target.sessionId === 'string') scope.sessionId = target.sessionId;
  if (typeof target.agentId === 'string') scope.agentId = target.agentId;
  return scope;
}

export function scopeRefFromProcedure(procedure: KlientProcedure): ScopeRef {
  if (procedure.scope === 'workspace') return { workspaceId: procedure.workspaceId };
  if (procedure.scope === 'session') return { sessionId: procedure.sessionId };
  if (procedure.scope === 'agent') {
    return { sessionId: procedure.sessionId, agentId: procedure.agentId };
  }
  return {};
}

export function eventSourceFromTarget(target: KlientTarget): EventSourceRef {
  if (typeof target.service === 'string' && typeof target.event === 'string') {
    return { kind: 'emitter', service: target.service, event: target.event };
  }
  if (typeof target.event === 'string' && target.event.length > 0) {
    return { kind: 'stream', name: target.event };
  }
  throw new RPCError(REQUEST_INVALID, `unknown event stream: ${String(target.event)}`);
}

export function encodeJsonFrame(frame: KlientFrame): string {
  return JSON.stringify(frame);
}

export function decodeJsonFrame(raw: string): KlientFrame | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const frame = parsed as Record<string, unknown>;
    if (typeof frame['type'] !== 'string') return undefined;
    return frame as unknown as KlientFrame;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new RPCError(REQUEST_INVALID, `invalid klient procedure ${field}`);
  }
  return value;
}
