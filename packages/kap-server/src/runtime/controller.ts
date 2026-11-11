import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RuntimeStore, type RuntimeLease, type ManagedWriter } from './runtimeStore';

export const runtimeReleaseSchema = z.object({
  releaseId: z.string().min(1).max(256), serverVersion: z.string().min(1), buildId: z.string().optional(), buildChannel: z.string().optional(),
  executable: z.string().min(1), args: z.array(z.string()), rollbackVerifiedWith: z.array(z.string()).default([]),
  port: z.number().int().min(0).max(65535).optional(), idleExit: z.string().regex(/^\d+(ms|s|m|h)$/).optional(),
});
export type RuntimeRelease = z.infer<typeof runtimeReleaseSchema>;
export const switchOperationSchema = z.object({
  id: z.string(), phase: z.enum(['draining', 'starting', 'recovering', 'completed', 'cancelled', 'failed']),
  fromOwnerId: z.string().optional(), previous: runtimeReleaseSchema.optional(), target: runtimeReleaseSchema,
  reason: z.enum(['update', 'rollback', 'restart']), startedAt: z.number(), settledAt: z.number().optional(), error: z.string().optional(),
});
export type SwitchOperation = z.infer<typeof switchOperationSchema>;
export interface RuntimeDriver {
  alive(pid: number): boolean;
  probe(writer: ManagedWriter): Promise<boolean>;
  prepare(writer: ManagedWriter, operationId: string, action: 'prepare' | 'cancel'): Promise<void>;
  start(target: RuntimeRelease): Promise<void>;
}

export class RuntimeController {
  readonly store: RuntimeStore;
  private readonly lease: RuntimeLease;
  private flight?: Promise<void>;
  private closed = false;
  private ensureRequested = false;

  constructor(homeDir: string, private readonly driver: RuntimeDriver) {
    this.store = new RuntimeStore(homeDir);
    try { this.lease = this.store.lease('controller'); }
    catch (error) { this.store.close(); throw error; }
  }

  status() {
    const operation = this.store.read<unknown>('operation');
    const active = this.store.read<unknown>('active');
    return { writer: this.store.writer(), operation: operation === undefined ? undefined : switchOperationSchema.parse(operation),
      active: active === undefined ? undefined : runtimeReleaseSchema.parse(active) };
  }

  private save(operation: SwitchOperation): void {
    const parsed = switchOperationSchema.parse(operation);
    this.store.transaction(() => { this.store.write(`operations/${parsed.id}`, parsed); this.store.write('operation', parsed); });
  }

  async ensure(initial: RuntimeRelease): Promise<void> {
    if (this.status().active === undefined) this.store.write('active', runtimeReleaseSchema.parse(initial));
    this.ensureRequested = true;
    try { await this.reconcile(); } finally { this.ensureRequested = false; }
  }

  async activate(target: RuntimeRelease, reason: SwitchOperation['reason'] = 'update'): Promise<SwitchOperation> {
    const state = this.status();
    if (state.operation !== undefined && ['draining', 'starting', 'recovering'].includes(state.operation.phase)) {
      if (state.operation.target.releaseId === target.releaseId && state.operation.reason === reason) return state.operation;
      throw new Error('Another runtime switch is still waiting. Cancel that switch before selecting another release.');
    }
    const parsed = runtimeReleaseSchema.parse(target);
    if (reason === 'rollback' && (state.active === undefined || !parsed.rollbackVerifiedWith.includes(state.active.releaseId))) {
      throw new Error('Rollback is unavailable: this release has no canonical compatibility verification for the active release.');
    }
    const operation: SwitchOperation = { id: randomUUID(), phase: 'draining', fromOwnerId: state.writer?.ownerId,
      previous: state.active, target: parsed, reason, startedAt: Date.now() };
    this.save(operation);
    await this.reconcile();
    return this.status().operation!;
  }

  async cancel(operationId: string): Promise<void> {
    const state = this.status(), operation = state.operation;
    if (operation?.id !== operationId || operation.phase !== 'draining') throw new Error('This switch is no longer waiting.');
    if (state.writer !== undefined && this.driver.alive(state.writer.pid)) {
      await this.driver.prepare(state.writer, operationId, 'cancel');
    }
    this.save({ ...operation, phase: 'cancelled', settledAt: Date.now() });
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('The runtime controller is closed.'));
    this.flight ??= this.reconcileOnce().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private matches(writer: ManagedWriter, target: RuntimeRelease): boolean {
    return writer.serverVersion === target.serverVersion && writer.buildId === target.buildId && writer.buildChannel === target.buildChannel;
  }

  private clean(writer: ManagedWriter): boolean {
    const receipt = writer.exitReceipt;
    return receipt?.cleanupOutcome === 'closed' && receipt.resourcesAfter === 0;
  }

  private async launch(target: RuntimeRelease): Promise<void> {
    await this.driver.start(target);
    const writer = this.store.writer();
    if (writer === undefined || writer.phase !== 'ready' || !this.matches(writer, target) || !await this.driver.probe(writer)) {
      throw new Error('The replacement server did not publish the expected managed identity.');
    }
  }

  private async reconcileOnce(): Promise<void> {
    const { operation, active, writer } = this.status();
    const running = writer !== undefined && this.driver.alive(writer.pid);
    if (operation === undefined || !['draining', 'starting', 'recovering'].includes(operation.phase)) {
      if (running) {
        if (!await this.driver.probe(writer!)) throw new Error('The managed writer is still alive but unreachable; no replacement was started.');
        return;
      }
      if (writer?.phase === 'failed') throw new Error('The previous writer failed cleanup. Inspect its exit receipt before explicit recovery.');
      if (writer?.phase === 'exited' && !this.ensureRequested) return;
      if (active !== undefined) await this.launch(active);
      return;
    }
    const target = operation.phase === 'recovering' ? operation.previous : operation.target;
    if (target === undefined) { this.save({ ...operation, phase: 'failed', error: 'No previous release is available for recovery.', settledAt: Date.now() }); return; }
    if (writer !== undefined && writer.ownerId !== operation.fromOwnerId && this.matches(writer, target)) {
      if (writer.phase === 'ready' && running && await this.driver.probe(writer)) {
        this.store.write('active', target);
        this.save({ ...operation, phase: operation.phase === 'recovering' ? 'failed' : 'completed', settledAt: Date.now() });
        return;
      }
      if (running) return;
      if (!this.clean(writer)) { this.save({ ...operation, phase: 'failed', error: 'The replacement did not close cleanly. Explicit recovery is required.', settledAt: Date.now() }); return; }
    }
    if (operation.phase === 'draining' && writer?.ownerId === operation.fromOwnerId && running) {
      await this.driver.prepare(writer, operation.id, 'prepare');
      return;
    }
    if (running) return;
    if (writer !== undefined && writer.ownerId === operation.fromOwnerId && !this.clean(writer)) {
      this.save({ ...operation, phase: 'failed', error: 'The old writer has no clean exit receipt. Explicit recovery is required.', settledAt: Date.now() });
      return;
    }
    const starting = { ...operation, phase: operation.phase === 'recovering' ? 'recovering' : 'starting' } as SwitchOperation;
    this.save(starting);
    try {
      await this.launch(target);
      this.store.write('active', target);
      this.save({ ...starting, phase: starting.phase === 'recovering' ? 'failed' : 'completed', settledAt: Date.now() });
    } catch (error) {
      const failedWriter = this.store.writer();
      const message = error instanceof Error ? error.message : String(error);
      if (starting.phase !== 'recovering' && operation.previous !== undefined &&
        (failedWriter === undefined || (!this.driver.alive(failedWriter.pid) && this.clean(failedWriter)))) {
        this.save({ ...starting, phase: 'recovering', error: message });
      } else this.save({ ...starting, phase: 'failed', error: message, settledAt: Date.now() });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flight;
    this.lease.close();
    this.store.close();
  }
}
