/**
 * `externalDelegation` domain — durable external work ownership contract.
 *
 * Defines the Session-scoped root, named-child, dispatch, event, result, and
 * transcript operations used by narrow authenticated edges.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type ExternalDispatchStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ExternalAuthority {
  readonly principalFingerprint: string;
  readonly authorityFingerprint: string;
  readonly configFingerprint: string;
}

export interface ExternalDispatchable {
  readonly kind: 'main' | 'named';
  readonly profileName?: string;
  readonly description?: string;
}

export interface ExternalChildView {
  readonly taskName: string;
  readonly profileName: string;
  readonly latestDispatchId?: string;
}

export interface ExternalDispatchView {
  readonly dispatchId: string;
  readonly target: 'main' | 'named';
  readonly taskName?: string;
  readonly profileName?: string;
  readonly status: ExternalDispatchStatus;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly continuationOf?: string;
  /** Stable typed failure code; the untrusted provider message is never exposed. */
  readonly errorCode?: string;
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
}

export interface ExternalContinueRequest {
  readonly authority: ExternalAuthority;
  readonly dispatchId: string;
  readonly message: string;
}

export interface ExternalDispatchLookup {
  readonly authority: ExternalAuthority;
  readonly dispatchId: string;
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
  result(request: ExternalPageLookup): Promise<ExternalResultPage>;
  events(request: ExternalPageLookup): Promise<ExternalEventPage>;
  transcript(request: ExternalPageLookup): Promise<ExternalTranscriptPage>;
  cancel(request: ExternalDispatchLookup): Promise<ExternalDispatchView>;
}

export const ISessionExternalDelegationService: ServiceIdentifier<ISessionExternalDelegationService> =
  createDecorator<ISessionExternalDelegationService>('sessionExternalDelegationService');
