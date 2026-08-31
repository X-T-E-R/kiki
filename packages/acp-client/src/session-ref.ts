import { z } from 'zod';

import { AcpClientError, AcpClientErrorCode } from '#/errors';
import type { ExecutorSessionRefEnvelope } from '#/types';

const DEFAULT_MAX_BYTES = 32 * 1024;
const DEFAULT_MAX_DEPTH = 8;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

const envelopeSchema = z.object({
  executorId: z.string().min(1).max(256),
  version: z.number().int().positive(),
  ref: z.record(z.string(), z.unknown()),
}).strict();

export interface SessionRefValidationOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
}

function fail(message: string, cause?: unknown): never {
  throw new AcpClientError(AcpClientErrorCode.InvalidSessionRef, message, { cause });
}

function validateJson(value: unknown, path: string, depth: number, maxDepth: number): void {
  if (depth > maxDepth) fail(`Session ref exceeds maximum nesting depth at ${path}`);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`Session ref contains a non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJson(value[index], `${path}[${String(index)}]`, depth + 1, maxDepth);
    }
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`Session ref contains a non-JSON value at ${path}`);
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) fail(`Session ref contains a secret-like key at ${path}.${key}`);
    if (child === undefined) fail(`Session ref contains undefined at ${path}.${key}`);
    validateJson(child, `${path}.${key}`, depth + 1, maxDepth);
  }
}

export function parseExecutorSessionRefEnvelope(
  input: unknown,
  options: SessionRefValidationOptions = {},
): ExecutorSessionRefEnvelope {
  let parsed: z.infer<typeof envelopeSchema>;
  try {
    parsed = envelopeSchema.parse(input);
  } catch (error) {
    fail('Invalid executor session ref envelope', error);
  }
  validateJson(parsed.ref, 'ref', 0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, 'utf8') > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
    fail('Executor session ref envelope exceeds the size limit');
  }
  return {
    executorId: parsed.executorId,
    version: parsed.version,
    ref: Object.freeze({ ...parsed.ref }),
  };
}

export function serializeExecutorSessionRefEnvelope(
  envelope: ExecutorSessionRefEnvelope,
  options?: SessionRefValidationOptions,
): string {
  return JSON.stringify(parseExecutorSessionRefEnvelope(envelope, options));
}

export function deserializeExecutorSessionRefEnvelope(
  serialized: string,
  options?: SessionRefValidationOptions,
): ExecutorSessionRefEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    fail('Executor session ref envelope is not valid JSON', error);
  }
  return parseExecutorSessionRefEnvelope(value, options);
}
