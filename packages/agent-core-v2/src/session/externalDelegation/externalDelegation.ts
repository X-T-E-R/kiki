/**
 * `externalDelegation` domain — durable external work ownership contract.
 *
 * Defines the Session-scoped root, named-child, dispatch, event, result, and
 * transcript operations used by narrow authenticated edges.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ErrorCodes } from '#/errors';
import type { DispatchProfileCatalogEntry } from '#/session/dispatch/profileCatalogProjection';

export type ExternalDispatchStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/**
 * Stable external failure taxonomy. The raw provider/process error text is
 * untrusted (it can embed paths, credentials, URLs, or stack fragments), so
 * the external surface carries only a category code plus this module's
 * domain-owned one-sentence description; the raw text stays in server logs.
 */
export type ExternalFailureCategory =
  | 'auth_expired'
  | 'quota_exceeded'
  | 'model_not_supported'
  | 'network'
  | 'invalid_input'
  | 'internal';

const EXTERNAL_FAILURE_DESCRIPTIONS: Readonly<Record<ExternalFailureCategory, string>> = {
  auth_expired: 'External agent authentication expired or was rejected; re-authenticate the provider and retry.',
  quota_exceeded: 'External agent hit a provider quota or rate limit; retry after the limit resets.',
  model_not_supported: 'The requested model is not available for external delegation.',
  network: 'External agent could not reach the provider (network failure or timeout); retry.',
  invalid_input: 'External agent rejected the request input.',
  internal: 'External agent run failed.',
};

/** Known internal error codes mapped onto the external failure taxonomy. */
const CODE_TO_EXTERNAL_FAILURE: Readonly<Record<string, ExternalFailureCategory>> = {
  [ErrorCodes.PROVIDER_AUTH_ERROR]: 'auth_expired',
  [ErrorCodes.AUTH_TOKEN_UNAUTHORIZED]: 'auth_expired',
  [ErrorCodes.AUTH_TOKEN_MISSING]: 'auth_expired',
  [ErrorCodes.AUTH_LOGIN_REQUIRED]: 'auth_expired',
  [ErrorCodes.AUTH_PROVISIONING_REQUIRED]: 'auth_expired',
  [ErrorCodes.PROVIDER_RATE_LIMIT]: 'quota_exceeded',
  [ErrorCodes.MODEL_NOT_FOUND]: 'model_not_supported',
  [ErrorCodes.PROVIDER_NOT_FOUND]: 'model_not_supported',
  [ErrorCodes.AUTH_MODEL_NOT_RESOLVED]: 'model_not_supported',
  [ErrorCodes.PROVIDER_CONNECTION_ERROR]: 'network',
  [ErrorCodes.PROVIDER_OVERLOADED]: 'network',
  [ErrorCodes.VALIDATION_FAILED]: 'invalid_input',
  [ErrorCodes.REQUEST_INVALID]: 'invalid_input',
  [ErrorCodes.CONTEXT_OVERFLOW]: 'invalid_input',
};

/**
 * Classify an internal error code onto the external failure taxonomy.
 * Returns `undefined` for codes without a trusted mapping — callers must then
 * fall back to `internal` and keep the generic redaction.
 */
export function classifyExternalFailureCode(code: string): ExternalFailureCategory | undefined {
  return CODE_TO_EXTERNAL_FAILURE[code];
}

/** Domain-owned one-sentence description for a failure category. */
export function externalFailureDescription(category: ExternalFailureCategory): string {
  return EXTERNAL_FAILURE_DESCRIPTIONS[category];
}

/** Type guard for values crossing back over an external edge. */
export function isExternalFailureCategory(value: unknown): value is ExternalFailureCategory {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(EXTERNAL_FAILURE_DESCRIPTIONS, value)
  );
}

export interface ExternalAuthority {
  readonly principalFingerprint: string;
  readonly authorityFingerprint: string;
  readonly configFingerprint: string;
}

export interface ExternalDispatchable extends Partial<DispatchProfileCatalogEntry> {
  readonly kind: 'main' | 'named';
}

export interface ExternalChildView {
  readonly taskName: string;
  readonly profileName: string;
  readonly latestDispatchId?: string;
}

export interface DispatchUsageView {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ExternalDispatchView {
  readonly dispatchId: string;
  readonly target: 'main' | 'named';
  readonly taskName?: string;
  readonly profileName?: string;
  readonly agentId?: string;
  readonly actualProfile?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly status: ExternalDispatchStatus;
  readonly nextStep?: string;
  readonly continueHint?: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly continuationOf?: string;
  readonly usage?: DispatchUsageView;
  /**
   * Stable failure category (`ExternalFailureCategory`); the untrusted
   * provider/process message is never exposed — `result()` pages carry only
   * the category's domain-owned description.
   */
  readonly errorCode?: ExternalFailureCategory;
}

export interface ExternalRootView {
  readonly version: 1;
  readonly delegationId: string;
  readonly lifecycle: 'active' | 'closed';
  readonly dispatchables: readonly ExternalDispatchable[];
  readonly children: readonly ExternalChildView[];
  readonly continuations: readonly ExternalDispatchView[];
}

export interface ExternalDispatchRequest {
  readonly authority: ExternalAuthority;
  readonly message: string;
  readonly target: 'main' | 'named';
  readonly taskName?: string;
  readonly profileName?: string;
  readonly dispatchKey?: string;
  /** Exact model binding for a newly-created named child. */
  readonly modelAlias?: string;
  /** Exact thinking binding for a newly-created named child. */
  readonly thinkingEffort?: string;
}

export interface ExternalContinueRequest {
  readonly authority: ExternalAuthority;
  readonly dispatchId: string;
  readonly message: string;
  readonly dispatchKey?: string;
}

export interface ExternalDispatchLookup {
  readonly authority: ExternalAuthority;
  readonly dispatchId: string;
}

export interface DispatchWaitRequest {
  readonly authority: ExternalAuthority;
  readonly dispatchId?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DispatchWaitView {
  readonly waitStatus: 'completed' | 'timed_out' | 'no_items';
  readonly waitedMs: number;
  readonly dispatch?: ExternalDispatchView;
  readonly completedDuringWait: readonly ExternalDispatchView[];
}

export interface ExternalPageLookup extends ExternalDispatchLookup {
  readonly cursor?: number;
  readonly limit?: number;
}

export interface ExternalResultPage {
  readonly dispatch: ExternalDispatchView;
  readonly text: string;
  readonly nextCursor?: number;
}

export interface ExternalEventView {
  readonly seq: number;
  readonly dispatchId: string;
  readonly type: 'queued' | 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly at: number;
  readonly message?: string;
}

export interface ExternalEventPage {
  readonly items: readonly ExternalEventView[];
  readonly nextCursor?: number;
}

export interface ExternalTranscriptItem {
  readonly index: number;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly text: string;
}

export interface ExternalTranscriptPage {
  readonly items: readonly ExternalTranscriptItem[];
  readonly nextCursor?: number;
}

export interface ISessionExternalDelegationService {
  readonly _serviceBrand: undefined;
  list(authority: ExternalAuthority): Promise<ExternalRootView>;
  dispatch(request: ExternalDispatchRequest): Promise<ExternalDispatchView>;
  continue(request: ExternalContinueRequest): Promise<ExternalDispatchView>;
  status(request: ExternalDispatchLookup): Promise<ExternalDispatchView>;
  wait(request: DispatchWaitRequest): Promise<DispatchWaitView>;
  result(request: ExternalPageLookup): Promise<ExternalResultPage>;
  events(request: ExternalPageLookup): Promise<ExternalEventPage>;
  transcript(request: ExternalPageLookup): Promise<ExternalTranscriptPage>;
  cancel(request: ExternalDispatchLookup): Promise<ExternalDispatchView>;
}

export const ISessionExternalDelegationService: ServiceIdentifier<ISessionExternalDelegationService> =
  createDecorator<ISessionExternalDelegationService>('sessionExternalDelegationService');
