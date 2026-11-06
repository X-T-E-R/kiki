import { Disposable, toDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { abortError } from '#/_base/utils/abort';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { LifecycleScope } from '#/app/scopes';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionExecutionControl, type ExecutionControlState, type ExecutionPauseParticipant, type ExecutionResumePoint } from './executionControl';
import { resumeAgentTask } from './resumeAgentTask';

interface ControlDocument {
  readonly version: 1 | 2;
  readonly checkpointComplete?: boolean;
  readonly requiredAgents?: readonly string[];
  readonly state: ExecutionControlState;
  readonly points: Readonly<Record<string, ExecutionResumePoint>>;
  readonly receipts: Readonly<Record<string, { readonly action: string; readonly state: ExecutionControlState }>>;
}

const KEY = 'execution-control.json';

export class SessionExecutionControl extends Disposable implements ISessionExecutionControl {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<ExecutionControlState>());
  readonly onDidChange = this.changed.event;
  private readonly participants = new Map<string, ExecutionPauseParticipant>();
  private document: ControlDocument = { version: 1, state: { phase: 'running', agents: [] }, points: {}, receipts: {} };
  private readonly loaded: Promise<void>;
  private initialized = false;
  private pauseController = new AbortController();
  private settleController?: AbortController;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly parked = new Set<string>();
  private readonly attachedTurns = new WeakSet<import('#/agent/loop/loop').Turn>();
  private readonly invalidatedTurns = new Map<string, Set<number>>();

  resumePoint(agentId: string): ExecutionResumePoint | undefined {
    const point = this.document.points[agentId];
    return point !== undefined && !this.invalidatedTurns.get(agentId)?.has(point.turnId) ? point : undefined;
  }
  park(agentId: string): void { this.parked.add(agentId); }
  isParked(agentId: string): boolean { return this.parked.has(agentId); }

  invalidate(agentId: string, turnId: number): Promise<void> {
    if (this.document.state.phase !== 'running') {
      const turns = this.invalidatedTurns.get(agentId) ?? new Set<number>();
      turns.add(turnId);
      this.invalidatedTurns.set(agentId, turns);
    }
    return this.serialize(async () => {
      await this.loaded;
      if (this.document.points[agentId]?.turnId !== turnId) return;
      const points = { ...this.document.points };
      delete points[agentId];
      const state = { ...this.document.state, agents: this.document.state.agents.map(agent => agent.agentId === agentId
        ? { ...agent, state: 'idle' as const, resumable: false, turnId: undefined } : agent) };
      await this.save({ ...this.document, state, points });
    });
  }

  constructor(
    @IAtomicDocumentStore private readonly documents: IAtomicDocumentStore,
    @ISessionContext private readonly session: ISessionContext,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this.loaded = this.load();
    void this.loaded.catch(() => undefined);
  }

  ready(): Promise<void> { return this.loaded; }
  pauseSignal(): AbortSignal { return this.pauseController.signal; }
  isPausing(): boolean { return this.document.state.phase === 'pausing'; }
  isDurablyPaused(): boolean { return this.document.state.phase === 'paused' && this.document.checkpointComplete === true; }
  isHeld(): boolean { return !this.initialized || this.document.state.phase !== 'running'; }
  async read(): Promise<ExecutionControlState> { await this.loaded; return structuredClone(this.document.state); }

  private async load(): Promise<void> {
    const saved = await this.documents.get<ControlDocument>(this.session.scope(), KEY);
    if (saved !== undefined) {
      if (saved.version !== 1 && saved.version !== 2) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Unsupported execution pause document');
      this.document = saved;
      if (saved.state.phase === 'pausing' || saved.state.phase === 'resuming') {
        await this.save({ ...saved, state: { ...saved.state, phase: 'failed', error: 'The process stopped before the control operation settled. Inspect saved work before resuming.' } });
      }
    }
    this.initialized = true;
    if (this.isHeld()) this.pauseController.abort(abortError('Execution pause requested'));
    this.changed.fire(structuredClone(this.document.state));
  }

  register(agentId: string, participant: ExecutionPauseParticipant) {
    this.participants.set(agentId, participant);
    return toDisposable(() => { if (this.participants.get(agentId) === participant) this.participants.delete(agentId); });
  }

  retainAgent(agentId: string): Promise<void> {
    if (!this.isHeld()) return Promise.resolve();
    return this.serialize(async () => {
      await this.loaded;
      if (!this.isHeld() || this.document.requiredAgents === undefined || this.document.requiredAgents.includes(agentId)) return;
      const document = { ...this.document, requiredAgents: [...this.document.requiredAgents, agentId] };
      await this.documents.set(this.session.scope(), KEY, document);
      this.document = document;
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(run, run);
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  pause(input: { readonly operationId: string }): Promise<ExecutionControlState> {
    return this.serialize(async () => {
      await this.loaded;
      this.validateId(input.operationId);
      const replay = this.receipt(input.operationId, 'pause');
      const retry = this.document.state.phase === 'failed' && this.document.state.pauseOperationId === input.operationId && !this.document.checkpointComplete;
      if (replay !== undefined && !retry) return replay;
      if (this.isHeld() && !retry) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Execution is already held; use its pause operation ID');
      const state: ExecutionControlState = {
        phase: 'pausing', pauseOperationId: input.operationId, requestedAt: new Date().toISOString(),
        agents: [...this.participants.keys()].map(agentId => ({ agentId, state: 'settling', resumable: false })),
      };
      if (retry && this.document.state.agents.some(agent => !this.participants.has(agent.agentId))) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'The interrupted execution has an unconfirmed outcome; inspect its original turn before replacing work');
      }
      const pending = { ...this.document, checkpointComplete: false, requiredAgents: [], state, points: {}, receipts: { ...this.document.receipts, [input.operationId]: { action: 'pause', state } } };
      try {
        await this.save(pending);
      } catch (error) {
        this.retainFailure(pending, error);
        throw error;
      }
      const controller = new AbortController();
      this.settleController = controller;
      void this.settlePause(input.operationId, controller);
      return state;
    });
  }

  private async settlePause(operationId: string, controller: AbortController): Promise<void> {
    const { signal } = controller;
    const results = new Map<string, { participant: ExecutionPauseParticipant; result: PromiseSettledResult<ExecutionResumePoint | undefined> }>();
    for (;;) {
      const next = [...this.participants.entries()].filter(([id, participant]) => {
        const prior = results.get(id);
        return prior?.participant !== participant || (participant.turnId !== undefined && prior.result.status === 'fulfilled' &&
          participant.turnId() !== prior.result.value?.turnId);
      });
      if (next.length === 0) break;
      const settled = await Promise.allSettled(next.map(([, participant]) => participant.pause(signal)));
      if (signal.aborted) return;
      next.forEach(([id, participant], index) => results.set(id, { participant, result: settled[index]! }));
    }
    await this.serialize(async () => {
      if (this.document.state.pauseOperationId !== operationId || this.document.state.phase !== 'pausing') return;
      const points: Record<string, ExecutionResumePoint> = {};
      const agents: ExecutionControlState['agents'][number][] = [];
      let failure: string | undefined;
      for (const [agentId, { result }] of results) {
        if (result.status === 'rejected') {
          failure = result.reason instanceof Error ? result.reason.message : String(result.reason);
          agents.push({ agentId, state: 'unknown', resumable: false, detail: failure });
        } else {
          const point = result.value !== undefined && !this.invalidatedTurns.get(agentId)?.has(result.value.turnId) ? result.value : undefined;
          if (point !== undefined) points[agentId] = point;
          agents.push({ agentId, state: point === undefined ? 'idle' : 'paused', resumable: point !== undefined, turnId: point?.turnId });
        }
      }
      const requiredAgents = new Set(this.document.requiredAgents);
      const state: ExecutionControlState = { ...this.document.state, phase: failure === undefined ? 'paused' : 'failed', pausedAt: failure === undefined ? new Date().toISOString() : undefined, agents, error: failure };
      try {
        for (const agent of this.lifecycle.list()) {
          if (agent.accessor.get(IAgentPromptService).hasQueuedWork() || agent.accessor.get(IAgentTaskService).hasUnfinishedWork(false)) requiredAgents.add(agent.id);
        }
        await this.save({ ...this.document, checkpointComplete: failure === undefined, requiredAgents: [...requiredAgents], state, points, receipts: { ...this.document.receipts, [operationId]: { action: 'pause', state } } });
      } catch (error) {
        this.retainFailure({ ...this.document, checkpointComplete: false }, error);
      }
    });
  }

  cancelPause(input: { readonly operationId: string; readonly pauseOperationId: string }): Promise<ExecutionControlState> {
    return this.release(input, true);
  }

  resume(input: { readonly operationId: string; readonly pauseOperationId: string }): Promise<ExecutionControlState> {
    return this.release(input, false);
  }

  private release(input: { readonly operationId: string; readonly pauseOperationId: string }, cancel: boolean): Promise<ExecutionControlState> {
    return this.serialize(async () => {
      await this.loaded;
      this.validateId(input.operationId);
      const action = `${cancel ? 'cancelPause' : 'resume'}:${input.pauseOperationId}`;
      const replay = this.receipt(input.operationId, action);
      if (replay !== undefined && !(this.document.state.phase === 'failed' && this.document.checkpointComplete)) return replay;
      const current = this.document.state;
      if (current.pauseOperationId !== input.pauseOperationId) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Execution control requires the current pause operation');
      }
      const queuedOwners = this.document.requiredAgents ?? current.agents.map(agent => agent.agentId);
      if (cancel) {
        const alreadyCanceled = current.phase === 'running' && current.cancelPauseOperationId !== undefined;
        const liveCheckpoint = current.phase === 'paused' && queuedOwners.every(agentId => this.participants.has(agentId)) &&
          Object.entries(this.document.points).every(([agentId, point]) =>
            this.resumePoint(agentId) === undefined || (!this.parked.has(agentId) && this.participants.get(agentId)?.turnId?.() === point.turnId));
        if (alreadyCanceled || current.phase === 'pausing' || liveCheckpoint) {
          const state: ExecutionControlState = alreadyCanceled ? current
            : { ...current, phase: 'running', agents: [], cancelPauseOperationId: input.operationId };
          await this.save({ ...this.document, checkpointComplete: false, state, points: {}, receipts: { ...this.document.receipts,
            [input.pauseOperationId]: { action: 'pause', state }, [input.operationId]: { action, state } } });
          return state;
        }
      }
      if (current.phase !== 'paused' && !(current.phase === 'failed' && this.document.checkpointComplete)) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'Resume requires the current durably paused operation');
      }
      const required = this.requiredOwners(this.document.requiredAgents === undefined
        ? current.agents.map(agent => agent.agentId)
        : [...this.document.requiredAgents, ...Object.keys(this.document.points)]);
      for (const agentId of required) {
        if (this.participants.has(agentId)) continue;
        const point = this.resumePoint(agentId);
        await this.lifecycle.create({ agentId, restoreBinding: point === undefined ? undefined : {
          profileName: point.binding.profileName, routeId: point.binding.routeId, modelAlias: point.binding.modelAlias,
          thinkingEffort: point.binding.thinkingLevel, thinkingEffortExplicit: point.binding.thinkingEffortExplicit,
          executorId: point.binding.executorId, executorProtocol: point.binding.executorProtocol,
        } });
      }
      const state: ExecutionControlState = { ...this.document.state, phase: 'resuming', resumeOperationId: input.operationId,
        cancelPauseOperationId: cancel ? input.operationId : undefined, error: undefined };
      const pending = { ...this.document, state, receipts: { ...this.document.receipts, [input.operationId]: { action, state } } };
      try {
        await this.save(pending);
        for (const [agentId, participant] of this.participants) {
          const turn = await participant.resume(this.resumePoint(agentId));
          if (turn !== undefined && !this.attachedTurns.has(turn)) {
            const agent = this.lifecycle.get(agentId)!;
            await resumeAgentTask(agent, turn);
            agent.accessor.get(IAgentPromptService).attachPausedTurn?.(turn);
            this.attachedTurns.add(turn);
          }
        }
        const resumed: ExecutionControlState = { ...state, phase: 'running', resumedAt: new Date().toISOString(), agents: [] };
        await this.save({ ...this.document, state: resumed, points: {}, receipts: { ...this.document.receipts, [input.operationId]: { action, state: resumed } } });
        return resumed;
      } catch (error) {
        this.retainFailure(pending, error);
        await this.save(this.document);
        throw error;
      }
    });
  }

  private requiredOwners(agentIds: readonly string[]): readonly string[] {
    const agents = this.metadata.snapshot().agents;
    const visited = new Set<string>();
    const required: string[] = [];
    const visit = (agentId: string): void => {
      if (visited.has(agentId)) return;
      visited.add(agentId);
      const meta = agents?.[agentId];
      const parent = meta?.delegator?.kind === 'agent' ? meta.delegator.agentId : meta?.parentAgentId;
      if (parent !== undefined && parent !== null) visit(parent);
      required.push(agentId);
    };
    for (const agentId of agentIds) visit(agentId);
    return required;
  }

  private validateId(id: string): void {
    if (id.length < 1 || id.length > 256) throw new Error2(ErrorCodes.REQUEST_INVALID, 'operationId must contain 1–256 characters');
  }

  private receipt(id: string, action: string): ExecutionControlState | undefined {
    const receipt = this.document.receipts[id];
    if (receipt === undefined) return undefined;
    if (receipt.action !== action) throw new Error2(ErrorCodes.REQUEST_INVALID, 'operationId was used for a different execution control operation');
    return structuredClone(receipt.state);
  }

  private retainFailure(document: ControlDocument, error: unknown): void {
    const state: ExecutionControlState = { ...document.state, phase: 'failed', error: error instanceof Error ? error.message : String(error) };
    const operationId = state.resumeOperationId ?? state.pauseOperationId;
    const receipt = operationId === undefined ? undefined : document.receipts[operationId];
    this.document = { ...document, state, receipts: operationId === undefined || receipt === undefined ? document.receipts
      : { ...document.receipts, [operationId]: { ...receipt, state } } };
    this.changed.fire(structuredClone(state));
  }

  private async save(input: ControlDocument): Promise<void> {
    const version = Object.values(input.points).some(point => point.pendingStep !== undefined) ? 2 : 1;
    const document: ControlDocument = { ...input, version };
    await this.documents.set(this.session.scope(), KEY, document);
    if (document.state.phase !== 'running') this.document = document;
    await this.metadata.update({ executionPhase: document.state.phase });
    this.document = document;
    if (document.state.phase === 'running') {
      if (this.pauseController.signal.aborted) this.pauseController = new AbortController();
      this.settleController?.abort(abortError('Pause request withdrawn'));
      this.settleController = undefined;
      this.invalidatedTurns.clear();
    } else this.pauseController.abort(abortError('Execution pause requested'));
    this.changed.fire(structuredClone(document.state));
  }
}

registerScopedService(LifecycleScope.Session, ISessionExecutionControl, SessionExecutionControl, ScopeActivation.OnDemand);
