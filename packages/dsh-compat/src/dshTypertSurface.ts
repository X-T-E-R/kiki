import { Context, Service } from '@kiki/cordis-runtime';

export class RemoteError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.details = details;
  }
}

export const TYPERT_OWNED_VALUE: unique symbol = Symbol.for('@deepseek-ai/dsh-typert-protocol/owned-value');

export interface TypertOwnedValue<T = unknown> {
  readonly [TYPERT_OWNED_VALUE]: true;
  readonly value: T;
}

export function typertOwnedValue<T>(value: T): TypertOwnedValue<T> {
  return { [TYPERT_OWNED_VALUE]: true, value };
}

export function isTypertOwnedValue(candidate: unknown): candidate is TypertOwnedValue {
  return typeof candidate === 'object' && candidate !== null && TYPERT_OWNED_VALUE in candidate;
}

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}

export function Remote(_options?: unknown) {
  return function remoteDecorator(_method: unknown, _context?: unknown): void {};
}

export abstract class TypertRemoteService<T = never> extends Service<T> {}

export function bindTypertRemote<TService extends object>(
  service: TService,
  serviceKey: string,
  options: { readonly namespace?: string } = {},
): {
  readonly service: TService;
  readonly serviceKey: string;
  readonly namespace: string;
} {
  return Object.freeze({
    service,
    serviceKey,
    namespace: options.namespace ?? serviceKey,
  });
}

export class TypertRegistry extends Service {
  private readonly schemas = new Map<string, unknown>();

  constructor(ctx: Context) {
    super(ctx, 'typertRegistry');
  }

  register(contribution: { readonly key?: string }): () => void {
    const key = contribution.key ?? `anon:${this.schemas.size}`;
    this.schemas.set(key, contribution);
    return () => {
      this.schemas.delete(key);
    };
  }

  get(key: string): unknown {
    return this.schemas.get(key);
  }

  list(): unknown[] {
    return [...this.schemas.values()];
  }
}

export default TypertRegistry;
