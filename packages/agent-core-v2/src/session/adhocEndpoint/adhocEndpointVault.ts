import { randomUUID } from 'node:crypto';
import { boundEndpointSchema, type AdhocEndpointInput, type BoundEndpoint } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import type { ToolCall } from '#/kosong/contract/message';
import { Error2, ErrorCodes } from '#/errors';

export interface IAdhocEndpointVault {
  readonly _serviceBrand: undefined;
  store(secret: string): string;
  read(secretRef: string): string | undefined;
  retain(endpoint: BoundEndpoint): void;
  bind(input: AdhocEndpointInput, secretRef?: string): BoundEndpoint;
  scrub(agentId: string, call: ToolCall): ToolCall;
  remap(agentId: string, rawId: string, index: number | string | undefined, assigned: string): void;
  claim(agentId: string, callId: string): string | undefined;
  discard(agentId: string, callIds: readonly string[]): void;
  redact(value: string): string;
  approved(endpoint: BoundEndpoint): boolean;
  approve(endpoint: BoundEndpoint): void;
}

export const IAdhocEndpointVault = createDecorator<IAdhocEndpointVault>('adhocEndpointVault');

export function credentialUnavailable(): Error2 {
  return new Error2(ErrorCodes.PROVIDER_AUTH_ERROR, 'credential_unavailable: supply api_key_env or a new api_key for this endpoint.', { details: { reason: 'credential_unavailable', retry: false } });
}

export class AdhocEndpointVault extends Disposable implements IAdhocEndpointVault {
  declare readonly _serviceBrand: undefined;
  readonly #secrets = new Map<string, string>();
  readonly #calls = new Map<string, string>();
  readonly #retained = new Set<string>();
  readonly #grants = new Set<string>();

  store(secret: string): string {
    for (const [ref, value] of this.#secrets) if (value === secret) return ref;
    const ref = randomUUID();
    this.#secrets.set(ref, secret);
    return ref;
  }

  read(secretRef: string): string | undefined { return this.#secrets.get(secretRef); }
  retain(endpoint: BoundEndpoint): void {
    if (endpoint.credential.kind === 'ephemeral') this.#retained.add(endpoint.credential.secretRef);
  }

  bind(input: AdhocEndpointInput, secretRef?: string): BoundEndpoint {
    const { api_key, api_key_env, ...fields } = input;
    const credential = api_key_env !== undefined ? { kind: 'env' as const, env: api_key_env }
      : { kind: 'ephemeral' as const, secretRef: api_key === '[REDACTED]' ? secretRef : api_key === undefined ? secretRef : this.store(api_key) };
    if (credential.kind === 'ephemeral' && credential.secretRef === undefined) throw credentialUnavailable();
    const parsed = boundEndpointSchema.safeParse({ ...fields, credential });
    if (!parsed.success) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Invalid endpoint configuration. Provide base_url, model, and one credential source.');
    return parsed.data;
  }

  scrub(agentId: string, call: ToolCall): ToolCall {
    if (call.name !== 'AgentRun' && call.name !== 'CallTool') return call;
    const raw = call.arguments ?? '{}';
    let input: Record<string, unknown>;
    try { input = JSON.parse(raw) as Record<string, unknown>; }
    catch {
      const decoded = raw.replaceAll(/\\u([\da-f]{4})/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
      return /api_key/i.test(decoded) ? { ...call, arguments: '{"_redacted_truncated_json":' } : call;
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return call;
    if (call.name === 'CallTool' && input['name'] !== 'AgentRun') return call;
    const args = call.name === 'CallTool' ? input['arguments'] : input;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return call;
    const record = args as Record<string, unknown>;
    const endpoint = record['endpoint'];
    const records = [record, ...(endpoint !== null && typeof endpoint === 'object' && !Array.isArray(endpoint) ? [endpoint as Record<string, unknown>] : [])];
    for (const target of records) {
      const key = target['api_key'];
      if (typeof key !== 'string' || key === '[REDACTED]') continue;
      const ref = this.store(key);
      this.#calls.set(this.callKey(agentId, call.id, call._streamIndex), ref);
      target['api_key'] = '[REDACTED]';
    }
    return { ...call, arguments: JSON.stringify(input) };
  }

  remap(agentId: string, rawId: string, index: number | string | undefined, assigned: string): void {
    const key = this.callKey(agentId, rawId, index);
    const ref = this.#calls.get(key);
    if (ref === undefined) return;
    this.#calls.delete(key);
    this.#calls.set(this.callKey(agentId, assigned), ref);
  }

  claim(agentId: string, callId: string): string | undefined {
    const key = this.callKey(agentId, callId);
    return this.#calls.get(key);
  }

  discard(agentId: string, callIds: readonly string[]): void {
    for (const callId of callIds.length === 0 ? [undefined] : callIds) {
      const prefix = callId === undefined ? `${agentId}\0` : `${agentId}\0${callId}\0`;
      for (const [key, ref] of this.#calls) {
        if (!key.startsWith(prefix)) continue;
        this.#calls.delete(key);
        if (!this.#retained.has(ref) && ![...this.#calls.values()].includes(ref)) this.#secrets.delete(ref);
      }
    }
  }

  redact(value: string): string {
    for (const secret of this.#secrets.values()) if (secret.length > 0) value = value.replaceAll(secret, '[REDACTED]');
    return value;
  }

  approved(endpoint: BoundEndpoint): boolean { return this.#grants.has(this.grantKey(endpoint)); }
  approve(endpoint: BoundEndpoint): void { this.#grants.add(this.grantKey(endpoint)); }
  private grantKey(endpoint: BoundEndpoint): string { return JSON.stringify([endpoint.base_url, endpoint.provider_type, endpoint.credential]); }
  private callKey(agentId: string, callId: string, index?: number | string): string { return `${agentId}\0${callId}\0${index ?? ''}`; }

  override async dispose(): Promise<void> {
    this.#secrets.clear();
    this.#calls.clear();
    this.#retained.clear();
    this.#grants.clear();
    await super.dispose();
  }
}

registerScopedService(LifecycleScope.Session, IAdhocEndpointVault, AdhocEndpointVault, ScopeActivation.OnDemand, 'adhocEndpoint');
