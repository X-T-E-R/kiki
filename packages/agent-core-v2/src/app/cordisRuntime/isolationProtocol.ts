import type { IsolatedPluginInvocation, IsolatedPluginResult } from './cordisRuntime';

export interface IsolationWorkerData {
  readonly entryUrl: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly maxPayloadBytes: number;
  readonly oldSpaceMb: number;
}

export type IsolationRequest = Omit<IsolatedPluginInvocation, 'signal' | 'timeoutMs'>;

export interface IsolationMessage {
  readonly id: number;
  readonly bytes: Uint8Array;
}

export type IsolationResponse = Omit<IsolatedPluginResult, 'value'> & (
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }
);

export function matchesInvocation(response: unknown, request: IsolationRequest): response is IsolationResponse {
  if (typeof response !== 'object' || response === null) return false;
  const value = response as Partial<IsolationResponse>;
  return value.pluginId === request.pluginId && value.generation === request.generation &&
    value.attemptId === request.attemptId && value.conversationRevision === request.conversationRevision &&
    typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 &&
    (value.ok === true || value.ok === false && typeof value.message === 'string');
}
