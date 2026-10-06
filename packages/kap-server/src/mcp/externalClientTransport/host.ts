import type { IAtomicDocumentStore } from '@kiki/agent-core-v2';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export class ExternalClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ExternalClientError';
  }
}

export interface ExternalClientGrant {
  readonly id: string;
  readonly resource: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly status?: 'active' | 'paused' | 'revoked';
  readonly subject?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExternalClientToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly execution?: { readonly taskSupport?: 'optional' | 'required' | 'forbidden' };
  readonly icons?: readonly Record<string, unknown>[];
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
}

export interface ExternalClientCallMeta {
  readonly requestId: string | number;
  readonly transportSessionId?: string;
  readonly clientInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly _meta?: Readonly<Record<string, unknown>>;
}

export interface ExternalClientTransportHost {
  readonly oauthStore?: IAtomicDocumentStore;
  readonly oauthStoreScope?: string;
  resolveBearer(
    token: string,
    context?: { readonly resource: string; readonly audience: string },
  ): ExternalClientGrant | null | Promise<ExternalClientGrant | null>;
  resolveGrant(grantId: string): ExternalClientGrant | null | Promise<ExternalClientGrant | null>;
  catalog(grant: ExternalClientGrant): readonly ExternalClientToolDescriptor[] | Promise<readonly ExternalClientToolDescriptor[]>;
  call(
    grant: ExternalClientGrant,
    name: string,
    args: Record<string, unknown>,
    meta: ExternalClientCallMeta,
    signal: AbortSignal,
  ): CallToolResult | Promise<CallToolResult>;
}

export function isActiveExternalClientGrant(grant: ExternalClientGrant | null | undefined): grant is ExternalClientGrant {
  return grant !== null && grant !== undefined && (grant.status === undefined || grant.status === 'active');
}
