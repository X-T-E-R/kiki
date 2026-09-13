import { globalContract, isStreamingContract } from '../contract/index.js';
import type {
  ProcedureContract,
  StreamingProcedureContract,
} from '../contract/types.js';
import type { CallOptions, EventSourceRef, IDisposable, ScopeRef } from '../core/channel.js';
import { RPCError } from '../core/errors.js';
import {
  KlientValidationError,
  parseChunk,
  parseInput,
  parseOutput,
} from '../core/validation.js';
import {
  createMemoryDispatcher,
  type MemoryDispatcher,
  type ScopeLike,
} from './memory/dispatcher.js';

const REQUEST_INVALID = 40001;
const INTERNAL_ERROR = 50001;

type ContractEntry = ProcedureContract | StreamingProcedureContract;

export interface ContractDispatcher {
  call(scope: ScopeRef, service: string, method: string, args: unknown[], options?: CallOptions): Promise<unknown>;
  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown>;
  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
    onReady?: () => void,
  ): IDisposable;
}

export function createContractDispatcher(root: ScopeLike): ContractDispatcher {
  const dispatcher = createMemoryDispatcher(root);

  return {
    async call(scope, service, method, args, options) {
      const { name, procedure } = resolveProcedure(service, method);
      if (isStreamingContract(procedure)) {
        throw new RPCError(REQUEST_INVALID, `${name} is a streaming procedure`);
      }
      const wireArgs = parseInputAsRpc(name, procedure, args);
      const data = await dispatcher.call(scope, service, method, wireArgs, options);
      return parseOutputAsRpc(name, procedure, data);
    },

    stream(scope, service, method, args) {
      const { name, procedure } = resolveProcedure(service, method);
      if (!isStreamingContract(procedure)) {
        throw new RPCError(REQUEST_INVALID, `${name} is not a streaming procedure`);
      }
      const wireArgs = parseInputAsRpc(name, procedure, args);
      return validatedStream(dispatcher, scope, service, method, wireArgs, name, procedure);
    },

    listen(scope, source, handler, onError, onReady) {
      return dispatcher.listen(scope, source, handler, onError, onReady);
    },
  };
}

function resolveProcedure(
  service: string,
  method: string,
): { readonly name: string; readonly procedure: ContractEntry } {
  const name = `${service}.${method}`;
  const procedure = globalContract[service]?.[method];
  if (procedure === undefined) {
    throw new RPCError(REQUEST_INVALID, `unknown klient procedure: ${name}`);
  }
  return { name, procedure };
}

function parseInputAsRpc(
  name: string,
  procedure: ContractEntry,
  args: unknown[],
): unknown[] {
  try {
    return parseInput(name, procedure, args);
  } catch (error) {
    if (error instanceof KlientValidationError) {
      const normalized = normalizeWireNullArgs(args, error);
      if (normalized !== args) {
        try {
          return parseInput(name, procedure, normalized);
        } catch (normalizedError) {
          throwValidationAsRpc(normalizedError, REQUEST_INVALID);
        }
      }
    }
    throwValidationAsRpc(error, REQUEST_INVALID);
  }
}

function normalizeWireNullArgs(args: unknown[], error: KlientValidationError): unknown[] {
  const invalidIndices = new Set(
    error.issues
      .map((issue) => issue.path[0])
      .filter((part): part is number => typeof part === 'number'),
  );
  let normalized: unknown[] | undefined;
  for (const index of invalidIndices) {
    if (args[index] !== null) continue;
    normalized ??= [...args];
    normalized[index] = undefined;
  }
  return normalized ?? args;
}

function parseOutputAsRpc(
  name: string,
  procedure: ProcedureContract,
  data: unknown,
): unknown {
  try {
    return parseOutput(name, procedure, data);
  } catch (error) {
    throwValidationAsRpc(error, INTERNAL_ERROR);
  }
}

function parseChunkAsRpc(
  name: string,
  procedure: StreamingProcedureContract,
  data: unknown,
): unknown {
  try {
    return parseChunk(name, procedure, data);
  } catch (error) {
    throwValidationAsRpc(error, INTERNAL_ERROR);
  }
}

function throwValidationAsRpc(error: unknown, code: number): never {
  if (error instanceof KlientValidationError) {
    throw new RPCError(code, error.message, error.issues);
  }
  throw error;
}

function validatedStream(
  dispatcher: MemoryDispatcher,
  scope: ScopeRef,
  service: string,
  method: string,
  args: unknown[],
  name: string,
  procedure: StreamingProcedureContract,
): AsyncIterable<unknown> {
  const source = dispatcher.stream(scope, service, method, args);
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next() {
          const result = await iterator.next();
          if (result.done) return { done: true as const, value: undefined };
          try {
            return {
              done: false,
              value: parseChunkAsRpc(name, procedure, result.value),
            };
          } catch (error) {
            await iterator.return?.();
            throw error;
          }
        },
        async return(value?: unknown) {
          await iterator.return?.(value);
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}
