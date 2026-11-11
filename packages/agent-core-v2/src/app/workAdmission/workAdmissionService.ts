import { AsyncLocalStorage } from 'node:async_hooks';
import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { Error2 } from '#/_base/errors/errors';
import { LifecycleScope } from '#/app/scopes';
import { WorkAdmissionErrors } from './errors';
import { IWorkAdmissionService, type WorkAdmission, type WorkAdmissionState } from './workAdmission';

interface Admission {
  readonly kind: string;
  readonly startedAt: number;
  references: number;
}

export class WorkAdmissionService extends Disposable implements IWorkAdmissionService {
  declare readonly _serviceBrand: undefined;
  private readonly context = new AsyncLocalStorage<Admission>();
  private readonly pending = new Set<Admission>();
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private operationId?: string;

  acquire(kind: string): WorkAdmission {
    let admission = this.context.getStore();
    if (admission === undefined || !this.pending.has(admission)) {
      if (this.operationId !== undefined) {
        throw new Error2(WorkAdmissionErrors.codes.WORK_ADMISSION_FENCED, 'Waiting to send after the server switch.', { details: { operationId: this.operationId } });
      }
      admission = { kind, startedAt: Date.now(), references: 0 };
      this.pending.add(admission);
    }
    const accepted = admission;
    accepted.references++;
    let disposed = false;
    const release = (): void => {
      if (--accepted.references !== 0) return;
      this.pending.delete(accepted);
      this.changed.fire();
    };
    this.changed.fire();
    return {
      run: operation => {
        if (!this.pending.has(accepted)) throw new Error2(WorkAdmissionErrors.codes.WORK_ADMISSION_FENCED, 'This work admission has ended.');
        return this.context.run(accepted, operation);
      },
      hold: completion => {
        if (disposed) throw new Error2(WorkAdmissionErrors.codes.WORK_ADMISSION_FENCED, 'This work admission has ended.');
        accepted.references++;
        let released = false;
        const releaseOnce = (): void => {
          if (released) return;
          released = true;
          release();
        };
        void completion.then(releaseOnce, releaseOnce);
        return toDisposable(releaseOnce);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        release();
      },
    };
  }

  async run<T>(kind: string, operation: () => Promise<T>): Promise<T> {
    const admission = this.acquire(kind);
    try { return await admission.run(operation); }
    finally { admission.dispose(); }
  }

  detach<T>(operation: () => T): T {
    return this.context.exit(operation);
  }

  fence(operationId: string): void {
    if (!operationId || (this.operationId !== undefined && this.operationId !== operationId)) {
      throw new Error2(WorkAdmissionErrors.codes.WORK_ADMISSION_FENCED, 'Another server switch owns admission.');
    }
    this.operationId = operationId;
    this.changed.fire();
  }

  reopen(operationId: string): void {
    if (this.operationId !== operationId) throw new Error2(WorkAdmissionErrors.codes.WORK_ADMISSION_FENCED, 'The server switch identity changed.');
    this.operationId = undefined;
    this.changed.fire();
  }

  state(): WorkAdmissionState {
    return { operationId: this.operationId, pending: [...this.pending].map(({ kind, startedAt }) => ({ kind, startedAt })) };
  }

  joined(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise(resolve => {
      const subscription = this.onDidChange(() => {
        if (this.pending.size > 0) return;
        subscription.dispose();
        resolve();
      });
    });
  }
}

registerScopedService(LifecycleScope.App, IWorkAdmissionService, WorkAdmissionService, ScopeActivation.OnDemand, 'workAdmission');
