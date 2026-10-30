import { createHash } from 'node:crypto';

import {
  ErrorCodes,
  IAtomicDocumentStore,
  IBootstrapService,
  IFileSystemStorageService,
  isError2,
  type Scope,
} from '@kiki/agent-core-v2';
import { z } from 'zod';

import { sessionCreateSchema, sessionSchema, type SessionCreate, type Session } from '../protocol/session';
import { ErrorCode } from '../protocol/error-codes';

const receiptWaitMs = 50;

export interface SessionCreateFailure {
  readonly code: number;
  readonly message: string;
  readonly details?: unknown;
}

export class SessionCreateReceiptError extends Error {
  override readonly name = 'SessionCreateReceiptError';

  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface SessionCreateReceipt {
  readonly version: 1;
  readonly scope: string;
  readonly creation_id: string;
  readonly session_id: string;
  readonly fingerprint: string;
  readonly body: SessionCreate;
  readonly status: 'pending' | 'completed' | 'failed' | 'unknown';
  readonly result?: Session;
  readonly failure?: SessionCreateFailure;
}

const receiptSchema = z.object({
  version: z.literal(1),
  scope: z.string().min(1),
  creation_id: z.string().uuid(),
  session_id: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  body: sessionCreateSchema,
  status: z.enum(['pending', 'completed', 'failed', 'unknown']),
  result: sessionSchema.optional(),
  failure: z.object({
    code: z.number().int(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
});

export type SessionCreateReceiptOperation = (sessionId: string) => Promise<Session>;
export type SessionCreateReceiptErrorMapper = (error: unknown) => SessionCreateFailure;
export type SessionCreateReceiptSessionProbe = (sessionId: string) => Promise<'present' | 'absent'>;

export class SessionCreateReceiptStore {
  private readonly flights = new Map<string, { readonly fingerprint: string; readonly promise: Promise<Session> }>();
  private readonly documents: IAtomicDocumentStore;
  private readonly storage: IFileSystemStorageService;
  private readonly storeScope: string;
  private readonly homeScope: string;

  constructor(private readonly core: Scope) {
    const bootstrap = core.accessor.get(IBootstrapService);
    this.documents = core.accessor.get(IAtomicDocumentStore);
    this.storage = core.accessor.get(IFileSystemStorageService);
    this.storeScope = bootstrap.scope('store');
    this.homeScope = sessionCreateReceiptHomeScope(bootstrap.homeDir, bootstrap.spaceId);
  }

  run(
    connectionScope: string,
    body: SessionCreate,
    operation: SessionCreateReceiptOperation,
    mapError: SessionCreateReceiptErrorMapper,
    probe: SessionCreateReceiptSessionProbe,
    signal?: AbortSignal,
  ): Promise<Session> {
    const creationId = body.creation_id;
    if (creationId === undefined) throw new Error('Session creation receipts require creation_id.');
    const receiptKey = this.key(connectionScope, creationId);
    const fingerprint = sessionCreateReceiptFingerprint(body);
    const existing = this.flights.get(receiptKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw this.conflict(body);
      return this.wait(existing.promise, signal);
    }
    return this.startOrJoin(receiptKey, connectionScope, body, fingerprint, operation, mapError, probe, signal);
  }

  async status(connectionScope: string, creationId: string): Promise<import('@kiki/protocol').SessionCreationStatus> {
    const receipt = await this.read(connectionScope, creationId);
    if (receipt !== undefined && receipt.scope !== this.identity(connectionScope)) {
      throw new SessionCreateReceiptError(ErrorCode.PERSISTENCE_FAILURE, 'The session creation receipt belongs to another scope.');
    }
    return {
      creation_id: creationId,
      session_id: receipt?.session_id ?? `session_${creationId}`,
      status: receipt?.status ?? 'missing',
      session: receipt?.status === 'completed' ? receipt.result : undefined,
      failure: receipt?.failure,
    };
  }

  private async startOrJoin(
    receiptKey: string,
    connectionScope: string,
    body: SessionCreate,
    fingerprint: string,
    operation: SessionCreateReceiptOperation,
    mapError: SessionCreateReceiptErrorMapper,
    probe: SessionCreateReceiptSessionProbe,
    signal?: AbortSignal,
  ): Promise<Session> {
    for (;;) {
      signal?.throwIfAborted();
      const current = await this.read(connectionScope, body.creation_id!);
      if (current !== undefined) {
        this.assertBinding(current, connectionScope, body, fingerprint);
        if (current.status !== 'pending') return this.replay(current);
        const flight = this.flights.get(receiptKey);
        if (flight !== undefined) {
          if (flight.fingerprint !== fingerprint) throw this.conflict(body);
          return this.wait(flight.promise, signal);
        }
      }

      let lock: { release(): Promise<void> } | undefined;
      try {
        lock = await this.lock(connectionScope, body.creation_id!);
      } catch (error) {
        if (!isError2(error) || error.code !== ErrorCodes.STORAGE_LOCKED) throw error;
        await this.pause(signal);
        continue;
      }

      try {
        const raced = await this.read(connectionScope, body.creation_id!);
        if (raced !== undefined) {
          this.assertBinding(raced, connectionScope, body, fingerprint);
          if (raced.status !== 'pending') return this.replay(raced);
          const flight = this.flights.get(receiptKey);
          if (flight !== undefined) {
            if (flight.fingerprint !== fingerprint) throw this.conflict(body);
            return await this.wait(flight.promise, signal);
          }
          const recovered = await this.recoverPending(raced, probe);
          await this.write(connectionScope, body.creation_id!, recovered);
          return this.replay(recovered);
        }

        const pending: SessionCreateReceipt = {
          version: 1,
          scope: this.identity(connectionScope),
          creation_id: body.creation_id!,
          session_id: `session_${body.creation_id}`,
          fingerprint,
          body,
          status: 'pending',
        };
        await this.write(connectionScope, body.creation_id!, pending);
        const flight = this.execute(
          receiptKey,
          connectionScope,
          pending,
          lock,
          operation,
          mapError,
        );
        this.flights.set(receiptKey, { fingerprint, promise: flight });
        flight.finally(() => {
          if (this.flights.get(receiptKey)?.promise === flight) this.flights.delete(receiptKey);
        }).catch(() => undefined);
        const result = this.wait(flight, signal);
        lock = undefined;
        return await result;
      } finally {
        await lock?.release();
      }
    }
  }

  private async execute(
    receiptKey: string,
    connectionScope: string,
    pending: SessionCreateReceipt,
    lock: { release(): Promise<void> },
    operation: SessionCreateReceiptOperation,
    mapError: SessionCreateReceiptErrorMapper,
  ): Promise<Session> {
    const flight = (async (): Promise<Session> => {
      try {
        let result: Session;
        try {
          result = await operation(pending.session_id);
        } catch (error) {
          const failure = mapError(error);
          try {
            await this.write(connectionScope, pending.creation_id, {
              ...pending,
              status: 'failed',
              failure,
            });
          } catch (writeError) {
            throw new SessionCreateReceiptError(
              ErrorCode.PERSISTENCE_FAILURE,
              `Session creation failed and its receipt could not be saved: ${messageOf(writeError)}`,
              { cause: messageOf(error) },
            );
          }
          throw new SessionCreateReceiptError(failure.code, failure.message, failure.details);
        }
        try {
          await this.write(connectionScope, pending.creation_id, {
            ...pending,
            status: 'completed',
            result,
          });
        } catch (writeError) {
          throw new SessionCreateReceiptError(
            ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
            `Session ${pending.session_id} was created but its completion receipt could not be saved: ${messageOf(writeError)}`,
            {
              creation_id: pending.creation_id,
              session_id: pending.session_id,
              evidence: 'completion_receipt_write_failed',
            },
          );
        }
        return result;
      } finally {
        await lock.release();
      }
    })();
    flight.finally(() => {
      if (this.flights.get(receiptKey)?.promise === flight) this.flights.delete(receiptKey);
    }).catch(() => undefined);
    return flight;
  }

  private async recoverPending(
    receipt: SessionCreateReceipt,
    probe: SessionCreateReceiptSessionProbe,
  ): Promise<SessionCreateReceipt> {
    let state: 'present' | 'absent';
    try {
      state = await probe(receipt.session_id);
    } catch (error) {
      throw new SessionCreateReceiptError(
        ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
        `The pending session creation receipt could not verify ${receipt.session_id}: ${messageOf(error)}`,
        {
          creation_id: receipt.creation_id,
          session_id: receipt.session_id,
          evidence: 'session_read_error',
        },
      );
    }
    return {
      ...receipt,
      status: 'unknown',
      failure: {
        code: ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
        message: state === 'present'
          ? `Session creation outcome is unknown; ${receipt.session_id} exists without a durable completion receipt.`
          : `Session creation outcome is unknown; the pending receipt has no ${receipt.session_id} completion evidence.`,
        details: {
          creation_id: receipt.creation_id,
          session_id: receipt.session_id,
          evidence: state === 'present' ? 'session_present_without_completion' : 'session_absent',
        },
      },
    };
  }

  private replay(receipt: SessionCreateReceipt): Session {
    if (receipt.status === 'completed') {
      if (receipt.result === undefined) throw new SessionCreateReceiptError(ErrorCode.PERSISTENCE_FAILURE, 'The completed session creation receipt has no result.');
      return receipt.result;
    }
    const failure = receipt.failure;
    if (failure === undefined) throw new SessionCreateReceiptError(ErrorCode.PERSISTENCE_FAILURE, 'The session creation receipt is incomplete.');
    throw new SessionCreateReceiptError(failure.code, failure.message, failure.details);
  }

  private assertBinding(
    receipt: SessionCreateReceipt,
    connectionScope: string,
    body: SessionCreate,
    fingerprint: string,
  ): void {
    if (receipt.scope !== this.identity(connectionScope)) {
      throw new SessionCreateReceiptError(ErrorCode.PERSISTENCE_FAILURE, 'The session creation receipt belongs to another scope.');
    }
    if (receipt.creation_id !== body.creation_id || receipt.fingerprint !== fingerprint) throw this.conflict(body);
    if (receipt.session_id !== `session_${body.creation_id}`) {
      throw new SessionCreateReceiptError(ErrorCode.PERSISTENCE_FAILURE, 'The session creation receipt has an invalid reserved session id.');
    }
  }

  private conflict(body: SessionCreate): SessionCreateReceiptError {
    return new SessionCreateReceiptError(
      ErrorCode.SESSION_CREATE_IDEMPOTENCY_CONFLICT,
      'This creation_id was already used with a different session request body.',
      { creation_id: body.creation_id, reason: 'body_mismatch' },
    );
  }

  private async read(connectionScope: string, creationId: string): Promise<SessionCreateReceipt | undefined> {
    const scope = this.scope(connectionScope);
    let value: unknown;
    try {
      value = await this.documents.get(scope, `${creationId}.json`);
    } catch (error) {
      throw new SessionCreateReceiptError(
        ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
        `The session creation receipt for ${creationId} could not be read: ${messageOf(error)}`,
        {
          creation_id: creationId,
          session_id: `session_${creationId}`,
          evidence: 'receipt_read_error',
        },
      );
    }
    if (value === undefined) return undefined;
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success) {
      throw new SessionCreateReceiptError(
        ErrorCode.SESSION_CREATE_OUTCOME_UNKNOWN,
        `The session creation receipt for ${creationId} is unreadable.`,
        {
          creation_id: creationId,
          session_id: `session_${creationId}`,
          evidence: 'receipt_read_error',
        },
      );
    }
    return parsed.data as SessionCreateReceipt;
  }

  private write(connectionScope: string, creationId: string, receipt: SessionCreateReceipt): Promise<void> {
    return this.documents.set(this.scope(connectionScope), `${creationId}.json`, receipt);
  }

  private identity(connectionScope: string): string {
    return sessionCreateReceiptIdentity(this.homeScope, connectionScope);
  }

  private lockScope(connectionScope: string): string {
    return `${this.storeScope}/session-create-locks/${hashScope(this.identity(connectionScope))}`;
  }

  private scope(connectionScope: string): string {
    return sessionCreateReceiptStorageScope(this.storeScope, this.homeScope, connectionScope);
  }

  private key(connectionScope: string, creationId: string): string {
    return `${this.scope(connectionScope)}\0${creationId}`;
  }

  private lock(connectionScope: string, creationId: string): Promise<{ release(): Promise<void> }> {
    return this.storage.acquireLock(this.lockScope(connectionScope), `${creationId}.lock`, {
      waitForMs: 0,
      owner: { kind: 'session-create', sessionId: `session_${creationId}` },
    });
  }

  private async wait(promise: Promise<Session>, signal?: AbortSignal): Promise<Session> {
    if (signal === undefined) return promise;
    signal.throwIfAborted();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(signal.reason ?? new Error('request aborted')); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  private pause(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const finish = (error?: unknown): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      timer = setTimeout(() => { finish(); }, receiptWaitMs);
      timer.unref?.();
      if (signal !== undefined) {
        onAbort = () => { finish(signal.reason ?? new Error('request aborted')); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }

}

export function sessionCreateReceiptHomeScope(homeDir: string, spaceId?: string): string {
  return `${spaceId ?? 'main'}:${homeDir}`;
}

export function sessionCreateReceiptIdentity(homeScope: string, connectionScope: string): string {
  return `${homeScope}:${connectionScope}`;
}

export function sessionCreateReceiptStorageScope(
  storeScope: string,
  homeScope: string,
  connectionScope: string,
): string {
  return `${storeScope}/session-create/${hashScope(sessionCreateReceiptIdentity(homeScope, connectionScope))}`;
}

export function sessionCreateReceiptFingerprint(body: SessionCreate): string {
  return digest(canonicalJson(body));
}

export function sessionCreateConnectionScope(input: { readonly peer?: string; readonly web?: string }): string {
  return input.peer === undefined
    ? input.web === undefined ? 'local' : `web:${input.web}`
    : `peer:${input.peer}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashScope(value: string): string {
  return digest(value).slice(0, 32);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
