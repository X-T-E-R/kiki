import {
  createAdmissionGate, createCordisRuntime, scopeTarget,
  type AnyCordisPlugin, type CordisFiberHandle, type CordisPluginContext, type CordisScopeKey,
  type ScopeAdmissionGate, type WaterfallViolationReport,
} from '@kiki/cordis-runtime';

import { IInstantiationService, ref, type LiveRef } from '#/_base/di/instantiation';
import { IPluginExtensionPortRegistry } from '#/app/plugin/extensionSlots';
import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { SessionWillCreateEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { ICordisRuntimeService, MountedCordisPluginInfo } from './cordisRuntime';

interface RuntimeScope {
  readonly key: CordisScopeKey;
  readonly gate: ScopeAdmissionGate;
  readonly ctx: CordisPluginContext;
  readonly agents: Map<string, RuntimeScope>;
  dispose(): Promise<void>;
}

interface Mounted {
  readonly handle: CordisFiberHandle;
  readonly scope: RuntimeScope | undefined;
  readonly slots: readonly string[];
  readonly generation: number;
  violations: number;
  quarantinedReason?: string;
}

export class CordisRuntimeService extends Disposable implements ICordisRuntimeService {
  declare readonly _serviceBrand: undefined;
  private readonly changed = this._register(new Emitter<void>());
  private readonly reported = this._register(new Emitter<WaterfallViolationReport>());
  readonly onDidChangePlugins = this.changed.event;
  readonly onDidReportViolation = this.reported.event;
  private readonly runtime = createCordisRuntime(report => {
    const mounted = this.mounted.get(report.pluginId);
    if (mounted) {
      mounted.violations += 1;
      if (mounted.violations >= 3) void this.quarantinePlugin(report.pluginId, report.kind);
    }
    this.reported.fire(report);
  });
  readonly abi = this.runtime.abi;
  readonly rootContext = this.runtime.ctx;
  private readonly sessions = new Map<string, RuntimeScope>();
  private readonly mounted = new Map<string, Mounted>();
  private readonly generations = new Map<string, number>();

  constructor(@ref(IPluginExtensionPortRegistry) extensionPorts?: LiveRef<IPluginExtensionPortRegistry>) {
    super();
    this._register({ dispose: () => this.runtime.dispose() });
    if (extensionPorts) {
      let registration: ReturnType<CordisRuntimeService['provideHostService']> | undefined;
      const update = () => {
        registration?.dispose();
        registration = extensionPorts.current ? this.provideHostService('kiki.extensionPorts', extensionPorts.current) : undefined;
      };
      update();
      this._register(extensionPorts.onDidChange(update));
      this._register({ dispose: () => registration?.dispose() });
    }
  }

  attachSession(event: SessionWillCreateEvent): void {
    const container = event.readSeed(IInstantiationService) as InstantiationService;
    const session = this.createScope(this.rootContext, createAdmissionGate({ scopeKind: 'session', sessionId: event.sessionId }));
    if (this.sessions.has(event.sessionId)) throw new Error(`Cordis session ${event.sessionId} is already attached`);
    this.sessions.set(event.sessionId, session);
    container.onWillDispose(() => this.revokeSession(event.sessionId));
    event.onSessionDispose(async () => {
      await session.dispose();
      if (this.sessions.get(event.sessionId) === session) this.sessions.delete(event.sessionId);
    });
    event.onSessionDrain?.(() => this.revokeSession(event.sessionId), () => session.dispose());
  }

  attachAgentLifecycle(sessionId: string, lifecycle: IAgentLifecycleService): { dispose(): void } {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Cordis session ${sessionId} is unavailable`);
    const attach = (handle: IAgentScopeHandle) => this.attachAgent(sessionId, session, handle);
    const created = lifecycle.onWillCreate(attach);
    const removing = lifecycle.onWillRemove?.(agentId => session.agents.get(agentId)?.gate.revoke());
    const sealing = lifecycle.onWillSealTranscript?.(event => {
      const agent = session.agents.get(event.handle.id);
      agent?.gate.revoke();
      if (agent) event.waitUntil(agent.dispose());
    });
    for (const handle of lifecycle.list()) attach(handle);
    return { dispose() { created.dispose(); removing?.dispose(); sealing?.dispose(); } };
  }

  revokeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.gate.revoke();
    for (const agent of session?.agents.values() ?? []) agent.gate.revoke();
  }

  private attachAgent(sessionId: string, session: RuntimeScope, handle: IAgentScopeHandle): void {
    if (session.agents.has(handle.id)) return;
    const agent = this.createScope(session.ctx, createAdmissionGate({ scopeKind: 'agent', sessionId, agentId: handle.id }));
    session.agents.set(handle.id, agent);
    const container = handle.accessor.get(IInstantiationService) as InstantiationService;
    container.onWillDispose(() => agent.gate.revoke());
    container.anchorKernelEntry(async () => {
      await agent.dispose();
      if (session.agents.get(handle.id) === agent) session.agents.delete(handle.id);
    }, 'cordis:agent-drain');
  }

  private createScope(parent: CordisPluginContext, gate: ScopeAdmissionGate): RuntimeScope {
    const key = {};
    const scope = this.runtime.createScope(parent, key, gate);
    const agents = new Map<string, RuntimeScope>();
    let draining: Promise<void> | undefined;
    const record: RuntimeScope = { key, gate, ctx: scope.ctx, agents, dispose: () => {
      gate.revoke();
      return draining ??= (async () => {
        for (const agent of [...agents.values()].reverse()) await agent.dispose();
        await scope.dispose();
        for (const [id, mounted] of this.mounted) if (mounted.scope === record) this.mounted.delete(id);
        this.changed.fire();
      })();
    } };
    return record;
  }

  sessionScopeKey(sessionId: string) { return this.sessions.get(sessionId)?.key; }
  agentScopeKey(sessionId: string, agentId: string) { return this.sessions.get(sessionId)?.agents.get(agentId)?.key; }
  admissionGateForSession(sessionId: string) { return this.sessions.get(sessionId)?.gate; }
  admissionGateForAgent(sessionId: string, agentId: string) { return this.sessions.get(sessionId)?.agents.get(agentId)?.gate; }

  scopeTargetForSession<T extends object>(sessionId: string, subject: T) {
    const key = this.sessionScopeKey(sessionId);
    if (!key) throw new Error(`Cordis session ${sessionId} is unavailable`);
    return scopeTarget(subject, key);
  }

  scopeTargetForAgent<T extends object>(sessionId: string, agentId: string, subject: T) {
    const key = this.agentScopeKey(sessionId, agentId);
    if (!key) throw new Error(`Cordis agent ${sessionId}/${agentId} is unavailable`);
    return scopeTarget(subject, key);
  }

  provideHostService(name: string, implementation: unknown) {
    if (!name.startsWith('kiki.')) throw new Error('Host ports must use the kiki namespace');
    const dispose = this.rootContext.provide(name, implementation);
    return { dispose };
  }

  mountInProcessPlugin<TConfig>(input: {
    readonly pluginId: string; readonly declaredSlots: readonly string[]; readonly plugin: AnyCordisPlugin<TConfig>;
    readonly config?: TConfig; readonly scope?: { readonly sessionId: string; readonly agentId?: string };
  }): CordisFiberHandle {
    if (this.mounted.has(input.pluginId)) throw new Error(`Cordis plugin ${input.pluginId} is already mounted`);
    const session = input.scope ? this.sessions.get(input.scope.sessionId) : undefined;
    const scope = input.scope?.agentId ? session?.agents.get(input.scope.agentId) : session;
    if (input.scope && !scope) throw new Error('Plugin target scope is unavailable');
    const handle = this.runtime.mount(scope?.ctx ?? this.rootContext, input.pluginId, input.plugin, input.config);
    const generation = (this.generations.get(input.pluginId) ?? 0) + 1;
    this.generations.set(input.pluginId, generation);
    const mounted: Mounted = { handle, generation, scope, slots: [...input.declaredSlots], violations: 0 };
    this.mounted.set(input.pluginId, mounted);
    const dispose = async () => {
      if (this.mounted.get(input.pluginId) === mounted) await this.unmountPlugin(input.pluginId);
    };
    this.changed.fire();
    return { uid: handle.uid, pluginId: handle.pluginId, get phase() { return handle.phase; }, ready: handle.ready,
      updateConfig: config => handle.updateConfig(config), dispose };
  }

  async unmountPlugin(pluginId: string): Promise<void> {
    const mounted = this.mounted.get(pluginId);
    if (!mounted) return;
    await mounted.handle.dispose();
    if (this.mounted.get(pluginId) === mounted) this.mounted.delete(pluginId);
    this.changed.fire();
  }

  async quarantinePlugin(pluginId: string, reason: string): Promise<void> {
    const mounted = this.mounted.get(pluginId);
    if (!mounted || mounted.quarantinedReason) return;
    mounted.quarantinedReason = reason;
    await mounted.handle.dispose();
    this.changed.fire();
  }

  listMountedPlugins(): readonly MountedCordisPluginInfo[] {
    return [...this.mounted].map(([pluginId, mounted]) => ({ pluginId, tier: 'in-process', generation: mounted.generation,
      phase: mounted.handle.phase, declaredSlots: mounted.slots, violationCount: mounted.violations, quarantinedReason: mounted.quarantinedReason }));
  }
}
