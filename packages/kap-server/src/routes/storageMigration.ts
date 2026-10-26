import type { FastifyInstance } from 'fastify';
import { storageMigrationActionSchema, type StorageMigrationAction, type StorageMigrationView } from '@kiki/protocol';
import type { MailboxMigrationService } from '@kiki/agent-core-v2/app/threadCommunication/mailboxMigration';

import { errEnvelope, okEnvelope } from '../envelope';
import { StorageStartupCleanupError } from '../storageStartupCleanup';

export class StorageMigrationController {
  private operation?: Promise<unknown>;
  private cleanup?: () => Promise<void>;
  private failure?: NonNullable<StorageMigrationView['operationFailure']>;
  private transition: StorageMigrationView['transition'] = { state: 'idle' };
  private activation?: AbortController;

  constructor(readonly service: MailboxMigrationService, private readonly mode: 'maintenance' | 'normal', private readonly activate?: (signal: AbortSignal) => Promise<void>) {}

  async view(): Promise<StorageMigrationView> {
    const status = await this.service.status();
    const actions: StorageMigrationView['actions'] = [];
    if (this.mode === 'maintenance' && this.transition.state === 'starting' && this.activation?.signal.aborted === false) actions.push('cancel');
    if (this.mode === 'maintenance' && this.cleanup !== undefined && this.operation === undefined) actions.push('retry_cleanup');
    if (this.mode === 'maintenance' && this.transition.state !== 'starting' && this.transition.cleanupPending !== true) {
      if (status.canCancel) actions.push('cancel');
      if (this.operation === undefined && !['running', 'cancelling'].includes(status.state)) {
        if (status.phase === 'rolling_back') actions.push('rollback');
        else if (status.authority === 'sqlite' && status.state === 'complete') {
          actions.push('start');
          if (status.canRollback) actions.push('rollback');
        } else {
          actions.push('migrate');
          if (status.canRollback) actions.push('rollback');
        }
      }
    }
    return { schemaVersion: 1, mode: this.mode, status, actions, transition: this.transition, operationFailure: this.failure };
  }

  async action(action: StorageMigrationAction['action']): Promise<boolean> {
    const view = await this.view();
    if (!view.actions.includes(action) || this.operation !== undefined && action !== 'cancel') return false;
    if (this.transition.state === 'starting') {
      if (action !== 'cancel') return false;
      this.activation?.abort(new DOMException('Normal startup cancelled; the SQLite upgrade is preserved', 'AbortError'));
      return true;
    }
    this.failure = undefined;
    if (action === 'start') {
      this.activation = new AbortController();
      this.transition = { state: 'starting' };
    } else if (action === 'retry_cleanup') {
      const cleanup = this.cleanup!;
      this.launch(async () => {
        try {
          await cleanup();
          this.cleanup = undefined;
          this.transition = { ...this.transition, cleanupPending: false, cleanupFailure: undefined };
        } catch (error) {
          this.transition = { ...this.transition, cleanupPending: true, cleanupFailure: failure(error, 'mailbox.cleanup_failed') };
        }
      });
    } else {
      this.launch(async () => action === 'migrate' ? this.service.migrate() : action === 'cancel' ? this.service.cancel() : this.service.rollback());
    }
    return true;
  }

  activateRequested(): void {
    if (this.transition.state !== 'starting' || this.operation !== undefined) return;
    const activation = this.activation!;
    const interrupted = (): void => { this.transition = { state: 'failed', failure: failure(activation.signal.reason), cleanupPending: true }; };
    activation.signal.addEventListener('abort', interrupted, { once: true });
    const deadline = setTimeout(() => activation.abort(new DOMException('Normal startup timed out; the SQLite upgrade is preserved. Retry startup after cleanup, or review the server log.', 'TimeoutError')), 30_000);
    deadline.unref();
    this.launch(async () => {
      try { activation.signal.throwIfAborted(); await this.activate!(activation.signal); }
      catch (error) {
        if (error instanceof StorageStartupCleanupError) {
          this.cleanup = error.retryCleanup;
          this.transition = { state: 'failed', failure: failure(error.startupError), cleanupFailure: failure(error.cleanupError, 'mailbox.cleanup_failed'), cleanupPending: true };
        } else this.transition = { state: 'failed', failure: failure(error) };
      }
      finally {
        clearTimeout(deadline);
        activation.signal.removeEventListener('abort', interrupted);
        if (this.transition.state === 'failed' && this.cleanup === undefined) this.transition = { ...this.transition, cleanupPending: false };
        this.activation = undefined;
      }
    });
  }

  private launch(run: () => Promise<unknown>): void {
    const current = Promise.resolve().then(run).catch((error: unknown) => { this.failure = failure(error); }).finally(() => { if (this.operation === current) this.operation = undefined; });
    this.operation = current;
  }

  async close(): Promise<void> {
    this.activation?.abort(new DOMException('Storage maintenance closed', 'AbortError'));
    try { await this.service.close(); }
    finally {
      await this.operation;
      await this.cleanup?.();
      this.cleanup = undefined;
    }
  }
}

function failure(error: unknown, fallback = 'mailbox.migration_failed'): { code: string; message: string } {
  const code = (error as { code?: unknown })?.code;
  return { code: error instanceof Error && error.name === 'AbortError' ? 'mailbox.start_cancelled'
    : error instanceof Error && error.name === 'TimeoutError' ? 'mailbox.start_timeout'
      : typeof code === 'string' ? code : fallback, message: error instanceof Error ? error.message : String(error) };
}

export function registerStorageMigrationRoutes(app: FastifyInstance, controller: StorageMigrationController): void {
  app.get('/api/storage', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return reply.send(okEnvelope(await controller.view(), request.id));
  });
  app.post('/api/storage', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = storageMigrationActionSchema.safeParse(request.body);
    if (!parsed.success) return reply.send(errEnvelope(40001, 'Choose migrate, cancel, rollback, start or retry_cleanup', request.id));
    if (!await controller.action(parsed.data.action)) return reply.send(errEnvelope(40901, 'This action is not available in the current storage state. Refresh storage status.', request.id));
    if (parsed.data.action === 'start') reply.raw.once('finish', () => controller.activateRequested());
    return reply.send(okEnvelope(await controller.view(), request.id));
  });
}
