import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { PluginGuiSlotContribution, PluginHttpRouteDescriptor, PluginWsTopicDescriptor } from '@kiki/protocol';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type {
  ApprovedToolExecutionWrapperContext,
  CompactionPolicyContribution,
  DynamicExecutorContribution,
  LoopBoundaryProposal,
  LoopBoundarySnapshot,
  LoopFailureSnapshot,
  PluginHttpRouteHandlerContext,
  PluginHttpRouteResult,
  PromptSectionContribution,
  RecoveryProposal,
  StepContextReminderContribution,
  SubagentDispatchProposal,
  SubagentDispatchSnapshot,
  SubagentReturnProposal,
  ToolResultBudgetContribution,
} from '#/app/plugin/extensionSlots';
import { IPluginExtensionPortRegistry } from '#/app/plugin/extensionSlots';
import type { AgentExecutorContext, AgentExecutorProtocol, AgentExecutorSession } from '#/app/agentExecutor/agentExecutor';
import type { FrozenLLMRequestSnapshot, LLMStreamTapObserver, PreBaselineRequestPatch, SettledLLMResponseSnapshot } from '#/kosong/contract/extensionHooks';
import type { DynamicProtocolBaseContribution, DynamicProviderContribution, IDynamicProtocolExtensionRegistry } from '#/kosong/protocol/extensionRegistry';
import { IProtocolAdapterRegistry } from '#/kosong/protocol/protocol';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type {
  ApprovedToolExecutionWrapper,
  ExtensionPortInvocationError,
  HttpRouteHandler,
  LoopPolicyHandler,
  RecoveryPolicyHandler,
  RequestPolicyHandler,
  SettledResponseObserver,
  SubagentDispatchAdvisor,
  SubagentReturnAdvisor,
  ToolPostExecuteHandler,
  ToolPreExecuteHandler,
} from './pluginExtensionPortRegistry';
import { IPluginExtensionPortRegistryReader } from './pluginExtensionPortRegistry';

interface Entry<T> {
  readonly pluginId: string;
  readonly value: T;
  readonly sequence: number;
  readonly order?: number;
  active: boolean;
  inflight: number;
  idle?: { readonly promise: Promise<void>; readonly resolve: () => void };
  readonly sessions?: Set<AgentExecutorSession>;
}

class ContributionPort<T> {
  private readonly entries = new Set<Entry<T>>();

  constructor(private readonly changed: () => void) {}

  add(pluginId: string, value: T, order?: number, drainSessions = false): Entry<T> {
    const entry: Entry<T> = {
      pluginId,
      value,
      sequence: nextSequence(),
      order,
      active: true,
      inflight: 0,
      sessions: drainSessions ? new Set() : undefined,
    };
    this.entries.add(entry);
    this.changed();
    return entry;
  }

  remove(entry: Entry<T>): Promise<void> {
    if (!entry.active) return entry.idle?.promise ?? Promise.resolve();
    entry.active = false;
    this.entries.delete(entry);
    this.changed();
    const sessions = [...entry.sessions ?? []];
    entry.sessions?.clear();
    const shutdown = Promise.allSettled(sessions.map(session =>
      session.shutdown(new Error('Dynamic executor contribution withdrawn')),
    )).then(() => undefined);
    const drained = entry.inflight === 0 ? Promise.resolve() : this.ensureIdle(entry).promise;
    return Promise.all([shutdown, drained]).then(() => undefined);
  }

  list(): readonly Entry<T>[] {
    return [...this.entries].filter(entry => entry.active).toSorted((left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.sequence - right.sequence);
  }

  find(predicate: (entry: Entry<T>) => boolean): Entry<T> | undefined {
    return this.list().find(predicate);
  }

  async invoke<R>(entry: Entry<T>, operation: (value: T) => R | Promise<R>, signal: AbortSignal | undefined, commitAfterWithdrawal = false): Promise<R | undefined> {
    if (!entry.active) return undefined;
    signal?.throwIfAborted();
    entry.inflight += 1;
    try {
      const value = await operation(entry.value);
      signal?.throwIfAborted();
      return entry.active || commitAfterWithdrawal ? value : undefined;
    } finally {
      entry.inflight -= 1;
      if (entry.inflight === 0) entry.idle?.resolve();
    }
  }

  invokeSync<R>(entry: Entry<T>, operation: (value: T) => R): R | undefined {
    if (!entry.active) return undefined;
    return operation(entry.value);
  }

  trackSession(entry: Entry<T>, session: AgentExecutorSession): AgentExecutorSession {
    const sessions = entry.sessions!;
    let shutdown: Promise<void> | undefined;
    const tracked: AgentExecutorSession = {
      hooks: session.hooks,
      status: session.status.bind(session),
      canResumeBrokenOriginal: session.canResumeBrokenOriginal?.bind(session),
      canRetryBrokenConstruction: session.canRetryBrokenConstruction?.bind(session),
      steer: session.steer?.bind(session),
      updateBinding: session.updateBinding?.bind(session),
      cancel: session.cancel.bind(session),
      settled: session.settled.bind(session),
      run: async (request, options) => {
        if (!entry.active || shutdown !== undefined) throw new Error('Dynamic executor contribution withdrawn');
        return session.run(request, options);
      },
      shutdown: reason => shutdown ??= Promise.resolve().then(async () => {
        try {
          await session.shutdown(reason);
        } finally {
          await session.settled();
          sessions.delete(tracked);
        }
      }),
    };
    if (!entry.active) {
      void tracked.shutdown(new Error('Dynamic executor contribution withdrawn'));
      throw new Error('Dynamic executor contribution withdrawn during creation');
    }
    sessions.add(tracked);
    return tracked;
  }

  private ensureIdle(entry: Entry<T>): { readonly promise: Promise<void>; readonly resolve: () => void } {
    if (entry.idle !== undefined) return entry.idle;
    let resolve!: () => void;
    const promise = new Promise<void>(onResolve => { resolve = onResolve; });
    entry.idle = { promise, resolve };
    return entry.idle;
  }
}

let sequence = 0;
function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export class PluginExtensionPortRegistryService extends Disposable implements IPluginExtensionPortRegistryReader {
  declare readonly _serviceBrand: undefined;

  private readonly changedEmitter = this._register(new Emitter<void>());
  readonly onDidChange = this.changedEmitter.event;
  private readonly changed = (): void => this.changedEmitter.fire();
  private readonly protocols = new ContributionPort<DynamicProtocolBaseContribution>(this.changed);
  private readonly providers = new ContributionPort<DynamicProviderContribution>(this.changed);
  private readonly requestPolicies = new ContributionPort<RequestPolicyHandler>(this.changed);
  private readonly streamTapPort = new ContributionPort<LLMStreamTapObserver>(this.changed);
  private readonly settledObservers = new ContributionPort<SettledResponseObserver>(this.changed);
  private readonly recoveryPolicies = new ContributionPort<RecoveryPolicyHandler>(this.changed);
  private readonly promptSections = new ContributionPort<PromptSectionContribution>(this.changed);
  private readonly stepReminders = new ContributionPort<StepContextReminderContribution>(this.changed);
  private readonly compactionPolicies = new ContributionPort<CompactionPolicyContribution>(this.changed);
  private readonly preStepPolicies = new ContributionPort<LoopPolicyHandler>(this.changed);
  private readonly postStepPolicies = new ContributionPort<LoopPolicyHandler>(this.changed);
  private readonly toolPrePolicies = new ContributionPort<ToolPreExecuteHandler>(this.changed);
  private readonly toolWrappers = new ContributionPort<ApprovedToolExecutionWrapper>(this.changed);
  private readonly toolPostPolicies = new ContributionPort<ToolPostExecuteHandler>(this.changed);
  private readonly resultBudgets = new ContributionPort<ToolResultBudgetContribution>(this.changed);
  private readonly dispatchAdvisors = new ContributionPort<SubagentDispatchAdvisor>(this.changed);
  private readonly returnAdvisors = new ContributionPort<SubagentReturnAdvisor>(this.changed);
  private readonly executors = new ContributionPort<DynamicExecutorContribution>(this.changed);
  private readonly httpRoutes = new ContributionPort<{ readonly descriptor: PluginHttpRouteDescriptor; readonly handler: HttpRouteHandler }>(this.changed);
  private readonly wsTopics = new ContributionPort<PluginWsTopicDescriptor>(this.changed);
  private readonly guiSlots = new ContributionPort<PluginGuiSlotContribution>(this.changed);
  private readonly wsPublisher = this._register(new Emitter<Parameters<IPluginExtensionPortRegistry['publishWsTopicEvent']>[0]>());
  readonly onDidPublishWsTopicEvent = this.wsPublisher.event;

  constructor(
    @IProtocolAdapterRegistry private readonly protocolAdapters: IProtocolAdapterRegistry & Partial<IDynamicProtocolExtensionRegistry>,
  ) {
    super();
  }

  private registration<T>(port: ContributionPort<T>, entry: Entry<T>): IDisposable {
    return toDisposable(() => port.remove(entry));
  }

  registerProtocolBase(contribution: DynamicProtocolBaseContribution): IDisposable {
    if (this.protocolAdapters.registerDynamicProtocolBase === undefined) throw new Error('Dynamic protocol registry is unavailable');
    const delegated = this.protocolAdapters.registerDynamicProtocolBase(contribution);
    const entry = this.protocols.add(contribution.pluginId, contribution, contribution.generation);
    return toDisposable(async () => {
      await this.protocols.remove(entry);
      await delegated?.dispose();
    });
  }

  registerProviderAdapter(contribution: DynamicProviderContribution): IDisposable {
    if (this.protocolAdapters.registerDynamicProvider === undefined) throw new Error('Dynamic provider registry is unavailable');
    const delegated = this.protocolAdapters.registerDynamicProvider(contribution);
    const entry = this.providers.add(contribution.pluginId, contribution, contribution.generation);
    return toDisposable(async () => {
      await this.providers.remove(entry);
      await delegated?.dispose();
    });
  }

  registerRequestPolicy(pluginId: string, handler: RequestPolicyHandler): IDisposable {
    return this.registration(this.requestPolicies, this.requestPolicies.add(pluginId, handler));
  }

  registerStreamTap(pluginId: string, tap: LLMStreamTapObserver): IDisposable {
    return this.registration(this.streamTapPort, this.streamTapPort.add(pluginId, tap));
  }

  registerSettledResponseObserver(pluginId: string, observer: SettledResponseObserver): IDisposable {
    return this.registration(this.settledObservers, this.settledObservers.add(pluginId, observer));
  }

  registerRecoveryPolicy(pluginId: string, handler: RecoveryPolicyHandler): IDisposable {
    return this.registration(this.recoveryPolicies, this.recoveryPolicies.add(pluginId, handler));
  }

  registerPromptSection(contribution: PromptSectionContribution): IDisposable {
    return this.registration(this.promptSections, this.promptSections.add(contribution.pluginId, contribution, contribution.order));
  }

  registerStepContextReminder(contribution: StepContextReminderContribution): IDisposable {
    return this.registration(this.stepReminders, this.stepReminders.add(contribution.pluginId, contribution));
  }

  registerCompactionPolicy(contribution: CompactionPolicyContribution): IDisposable {
    return this.registration(this.compactionPolicies, this.compactionPolicies.add(contribution.pluginId, contribution, contribution.priority));
  }

  registerPreStepPolicy(pluginId: string, handler: LoopPolicyHandler): IDisposable {
    return this.registration(this.preStepPolicies, this.preStepPolicies.add(pluginId, handler));
  }

  registerPostStepPolicy(pluginId: string, handler: LoopPolicyHandler): IDisposable {
    return this.registration(this.postStepPolicies, this.postStepPolicies.add(pluginId, handler));
  }

  registerToolPreExecutePolicy(pluginId: string, handler: ToolPreExecuteHandler): IDisposable {
    return this.registration(this.toolPrePolicies, this.toolPrePolicies.add(pluginId, handler));
  }

  registerApprovedToolExecutionWrapper(pluginId: string, wrapper: ApprovedToolExecutionWrapper, options?: { readonly order?: number }): IDisposable {
    return this.registration(this.toolWrappers, this.toolWrappers.add(pluginId, wrapper, options?.order));
  }

  registerToolPostExecutePolicy(pluginId: string, handler: ToolPostExecuteHandler): IDisposable {
    return this.registration(this.toolPostPolicies, this.toolPostPolicies.add(pluginId, handler));
  }

  registerToolResultBudget(contribution: ToolResultBudgetContribution): IDisposable {
    return this.registration(this.resultBudgets, this.resultBudgets.add(contribution.pluginId, contribution));
  }

  registerSubagentDispatchAdvisor(pluginId: string, handler: SubagentDispatchAdvisor): IDisposable {
    return this.registration(this.dispatchAdvisors, this.dispatchAdvisors.add(pluginId, handler));
  }

  registerSubagentReturnAdvisor(pluginId: string, handler: SubagentReturnAdvisor): IDisposable {
    return this.registration(this.returnAdvisors, this.returnAdvisors.add(pluginId, handler));
  }

  registerDynamicExecutor(contribution: DynamicExecutorContribution): IDisposable {
    const existing = this.executors.find(entry => entry.value.protocol === contribution.protocol || entry.value.descriptor.id === contribution.descriptor.id);
    if (existing !== undefined) throw new Error(`Dynamic executor "${contribution.descriptor.id}" is already registered`);
    if (contribution.protocol === 'native' || contribution.descriptor.id === 'native'
      || contribution.descriptor.protocol !== contribution.protocol || contribution.provider.protocol !== contribution.protocol) {
      throw new Error('Dynamic executor protocol and descriptor must identify the same external executor');
    }
    const generation: DynamicExecutorContribution = Object.freeze({
      ...contribution, descriptor: Object.freeze({ ...structuredClone(contribution.descriptor),
        revision: `${contribution.descriptor.revision}/extension/${randomUUID()}` }),
    });
    return this.registration(this.executors, this.executors.add(contribution.pluginId, generation, undefined, true));
  }

  registerHttpRoute(descriptor: PluginHttpRouteDescriptor, handler: HttpRouteHandler): IDisposable {
    if (this.resolveHttpRoute(descriptor.pluginId, descriptor.method, descriptor.subpath) !== undefined) {
      throw new Error(`Plugin route ${descriptor.pluginId} ${descriptor.method} ${descriptor.subpath} is already registered`);
    }
    const route = { descriptor: Object.freeze({ ...descriptor }), handler };
    return this.registration(this.httpRoutes, this.httpRoutes.add(descriptor.pluginId, route));
  }

  resolveHttpRoute(
    pluginId: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    subpath: string,
  ): PluginHttpRouteDescriptor | undefined {
    return this.findHttpRoute(pluginId, method, subpath)?.value.descriptor;
  }

  async invokeHttpRoute(context: PluginHttpRouteHandlerContext): Promise<PluginHttpRouteResult | undefined> {
    const entry = this.findHttpRoute(context.pluginId, context.method, context.subpath);
    if (entry === undefined) return undefined;
    return this.httpRoutes.invoke(entry, route => route.handler(context), context.signal, true);
  }

  private findHttpRoute(pluginId: string, method: PluginHttpRouteDescriptor['method'], subpath: string) {
    const normalizedId = pluginId.toLowerCase();
    return this.httpRoutes.find(({ value: { descriptor } }) => descriptor.pluginId.toLowerCase() === normalizedId
      && descriptor.method === method && descriptor.subpath === subpath);
  }

  registerWsTopic(descriptor: PluginWsTopicDescriptor): IDisposable {
    if (this.resolveWsTopic(descriptor.pluginId, descriptor.topic) !== undefined) {
      throw new Error(`Plugin topic ${descriptor.pluginId}/${descriptor.topic} is already registered`);
    }
    return this.registration(this.wsTopics, this.wsTopics.add(descriptor.pluginId, Object.freeze({ ...descriptor })));
  }

  resolveWsTopic(pluginId: string, topic: string): PluginWsTopicDescriptor | undefined {
    const normalizedId = pluginId.toLowerCase();
    return this.wsTopics.find(entry => entry.value.pluginId.toLowerCase() === normalizedId && entry.value.topic === topic)?.value;
  }

  publishWsTopicEvent(input: Parameters<IPluginExtensionPortRegistry['publishWsTopicEvent']>[0]): void {
    if (this.resolveWsTopic(input.pluginId, input.topic) === undefined) return;
    this.wsPublisher.fire(input);
  }

  registerGuiSlot(contribution: PluginGuiSlotContribution): IDisposable {
    return this.registration(this.guiSlots, this.guiSlots.add(contribution.pluginId, contribution));
  }

  listGuiSlots(filter?: { readonly workspaceId?: string; readonly sessionId?: string }): readonly PluginGuiSlotContribution[] {
    return this.guiSlots.list().map(entry => entry.value).filter(contribution => {
      const scope = contribution as PluginGuiSlotContribution & { readonly workspaceId?: string; readonly sessionId?: string };
      return (filter?.workspaceId === undefined || scope.workspaceId === undefined || scope.workspaceId === filter.workspaceId)
        && (filter?.sessionId === undefined || scope.sessionId === undefined || scope.sessionId === filter.sessionId);
    });
  }

  get hasRequestPolicies(): boolean { return this.requestPolicies.list().length > 0; }

  get hasSettledResponseObservers(): boolean { return this.settledObservers.list().length > 0; }

  get hasCompactionPolicies(): boolean { return this.compactionPolicies.list().length > 0; }

  get hasRecoveryPolicies(): boolean { return this.recoveryPolicies.list().length > 0; }

  get hasLoopPolicies(): boolean { return this.preStepPolicies.list().length > 0 || this.postStepPolicies.list().length > 0; }

  get hasToolPreExecutePolicies(): boolean { return this.toolPrePolicies.list().length > 0; }

  get hasToolPostExecutePolicies(): boolean { return this.toolPostPolicies.list().length > 0; }

  get hasToolExecutionWrappers(): boolean { return this.toolWrappers.list().length > 0; }

  get hasSubagentDispatchAdvisors(): boolean { return this.dispatchAdvisors.list().length > 0; }

  get hasSubagentReturnAdvisors(): boolean { return this.returnAdvisors.list().length > 0; }

  async collectPreBaselinePatch(snapshot: FrozenLLMRequestSnapshot, signal: AbortSignal): Promise<PreBaselineRequestPatch> {
    let merged: PreBaselineRequestPatch = {};
    for (const entry of this.requestPolicies.list()) {
      const patch = await this.requestPolicies.invoke(entry, handler => handler(snapshot, signal), signal);
      if (patch === undefined) continue;
      merged = {
        ...merged,
        ...patch,
        extraHeaders: mergeRecords(merged.extraHeaders, patch.extraHeaders),
        sampling: mergeRecords(merged.sampling, patch.sampling),
        extraRequestParams: mergeRecords(merged.extraRequestParams, patch.extraRequestParams),
        deterministicVendorFields: mergeRecords(merged.deterministicVendorFields, patch.deterministicVendorFields),
      };
    }
    return merged;
  }

  activeStreamTaps(): readonly LLMStreamTapObserver[] {
    return this.streamTapPort.list().map(entry => (part, control) => {
      this.streamTapPort.invokeSync(entry, tap => tap(part, control));
      return undefined;
    });
  }

  async dispatchSettledResponse(snapshot: SettledLLMResponseSnapshot, signal: AbortSignal): Promise<readonly ExtensionPortInvocationError[]> {
    const errors: ExtensionPortInvocationError[] = [];
    for (const entry of this.settledObservers.list()) {
      try {
        await this.settledObservers.invoke(entry, observer => observer(snapshot, signal), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        errors.push({ pluginId: entry.pluginId, error });
      }
    }
    return errors;
  }

  async proposeRecovery(snapshot: LoopFailureSnapshot, signal: AbortSignal): Promise<RecoveryProposal> {
    for (const entry of this.recoveryPolicies.list()) {
      try {
        const proposal = await this.recoveryPolicies.invoke(entry, handler => handler(snapshot, signal), signal);
        if (proposal !== undefined && proposal.action !== 'pass') return proposal;
      } catch (error) {
        if (signal.aborted) throw error;
        return { action: 'abort_with_diagnostic', userFacingMessage: error instanceof Error ? error.message : String(error) };
      }
    }
    return { action: 'pass' };
  }

  async renderPromptSections(context: Parameters<PromptSectionContribution['render']>[0]): Promise<{ readonly text: string; readonly suppressRuntimeContext: boolean }> {
    const sections: string[] = [];
    let suppressRuntimeContext = false;
    for (const entry of this.promptSections.list()) {
      const text = await this.promptSections.invoke(entry, contribution => contribution.render(context), undefined);
      if (text === undefined || text.trim().length === 0) continue;
      sections.push(text.trim());
      suppressRuntimeContext ||= entry.value.suppressRuntimeContext === true;
    }
    return { text: sections.join('\n\n'), suppressRuntimeContext };
  }

  activeStepContextReminders(): readonly StepContextReminderContribution[] {
    return this.stepReminders.list().map(entry => entry.value);
  }

  async collectStepContextReminder(contribution: StepContextReminderContribution,
    context: Parameters<StepContextReminderContribution['collect']>[0]) {
    const entry = this.stepReminders.find(candidate => candidate.value === contribution);
    if (entry === undefined) return undefined;
    return this.stepReminders.invoke(entry, value => value.collect(context), context.signal);
  }

  async buildCompactionGuidance(
    selection: Parameters<NonNullable<CompactionPolicyContribution['matches']>>[0],
    context: Parameters<NonNullable<CompactionPolicyContribution['buildSummaryGuidance']>>[0],
  ): Promise<{ readonly additionalInstructions?: string; readonly preservedFileIndexMarkdown?: string }> {
    const instructions: string[] = [];
    const indexes: string[] = [];
    for (const entry of this.compactionPolicies.list()) {
      if (entry.value.matches?.(selection) === false) continue;
      const guidance = await this.compactionPolicies.invoke(entry, contribution => contribution.buildSummaryGuidance?.(context), context.signal);
      if (guidance?.additionalInstructions !== undefined && guidance.additionalInstructions.trim().length > 0) instructions.push(guidance.additionalInstructions.trim());
      if (guidance?.preservedFileIndexMarkdown !== undefined && guidance.preservedFileIndexMarkdown.trim().length > 0) indexes.push(guidance.preservedFileIndexMarkdown.trim());
    }
    return {
      additionalInstructions: instructions.length === 0 ? undefined : instructions.join('\n\n'),
      preservedFileIndexMarkdown: indexes.length === 0 ? undefined : indexes.join('\n\n'),
    };
  }

  proposePreStep(snapshot: LoopBoundarySnapshot, signal: AbortSignal): Promise<LoopBoundaryProposal> {
    return this.proposeBoundary(this.preStepPolicies, snapshot, signal);
  }

  proposePostStep(snapshot: LoopBoundarySnapshot, signal: AbortSignal): Promise<LoopBoundaryProposal> {
    return this.proposeBoundary(this.postStepPolicies, snapshot, signal);
  }

  private async proposeBoundary(port: ContributionPort<LoopPolicyHandler>, snapshot: LoopBoundarySnapshot, signal: AbortSignal): Promise<LoopBoundaryProposal> {
    for (const entry of port.list()) {
      const proposal = await port.invoke(entry, handler => handler(snapshot, signal), signal);
      if (proposal !== undefined && proposal.action !== 'continue_normal') return proposal;
    }
    return { action: 'continue_normal' };
  }

  async proposeToolPreExecute(context: Parameters<IPluginExtensionPortRegistryReader['proposeToolPreExecute']>[0]) {
    let args = context.args;
    const auditReasons: string[] = [];
    let requireAskReason: string | undefined;
    for (const entry of this.toolPrePolicies.list()) {
      const proposal = await this.toolPrePolicies.invoke(entry, handler => handler({ ...context, args }), context.signal);
      if (proposal === undefined) continue;
      switch (proposal.decision) {
        case 'pass':
          break;
        case 'propose_args':
          args = proposal.rewrittenArgs;
          auditReasons.push(proposal.auditReason);
          break;
        case 'require_ask':
          requireAskReason = proposal.promptReason;
          break;
        case 'veto':
          return { args, changed: !isDeepStrictEqual(args, context.args), auditReasons, requireAskReason,
            veto: { output: proposal.errorOutput, isError: true } };
      }
    }
    return { args, changed: !isDeepStrictEqual(args, context.args), auditReasons, requireAskReason };
  }

  async executeApprovedTool(context: ApprovedToolExecutionWrapperContext, terminal: (signal: AbortSignal) => Promise<ExecutableToolResult>): Promise<ExecutableToolResult> {
    const wrappers = this.toolWrappers.list();
    const invoke = async (index: number, signal: AbortSignal): Promise<ExecutableToolResult> => {
      signal.throwIfAborted();
      const entry = wrappers[index];
      if (entry === undefined) return terminal(signal);
      if (!entry.active) return invoke(index + 1, signal);
      const result = await this.toolWrappers.invoke(entry, async wrapper => {
        let continued = false;
        let drained: Promise<unknown> | undefined;
        let closed = false;
        const next = (overrideSignal?: AbortSignal): Promise<ExecutableToolResult> => {
          if (continued) return Promise.reject(new Error('Approved tool execution ticket was continued more than once'));
          if (closed) return Promise.reject(new Error('Approved tool execution ticket has closed'));
          continued = true;
          const downstream = Promise.resolve().then(() => {
            if (closed) throw new Error('Approved tool execution ticket has closed');
            return invoke(index + 1, overrideSignal === undefined ? signal : AbortSignal.any([signal, overrideSignal]));
          });
          drained = Promise.allSettled([downstream]);
          return downstream;
        };
        try {
          return await wrapper({ ...context, execContext: { ...context.execContext, signal } }, next);
        } finally {
          closed = true;
          await drained;
        }
      }, signal, true);
      if (result === undefined) throw new Error('Approved tool execution wrapper returned no result');
      return result;
    };
    return invoke(0, context.execContext.signal);
  }

  async proposeToolPostExecute(context: Parameters<IPluginExtensionPortRegistryReader['proposeToolPostExecute']>[0]) {
    let result = context.result;
    let preserveOriginalInAudit = false;
    const reminders: { text: string; variant: string }[] = [];
    for (const entry of this.toolPostPolicies.list()) {
      const proposal = await this.toolPostPolicies.invoke(entry, handler => handler({ ...context, result }), context.signal);
      if (proposal === undefined) continue;
      if (proposal.shapedResult !== undefined) result = proposal.shapedResult;
      preserveOriginalInAudit ||= proposal.preserveOriginalInAudit === true;
      if (proposal.oneOffSystemReminder !== undefined) reminders.push(proposal.oneOffSystemReminder);
    }
    return { result, preserveOriginalInAudit, reminders };
  }

  async formatToolResultPreview(input: Parameters<IPluginExtensionPortRegistryReader['formatToolResultPreview']>[0]): Promise<string | undefined> {
    for (const entry of this.resultBudgets.list()) {
      if (entry.value.toolNames !== undefined && !entry.value.toolNames.includes(input.toolName)) continue;
      const formatted = await this.resultBudgets.invoke(entry, contribution => contribution.formatPreview?.(input), undefined);
      if (formatted !== undefined) return formatted;
    }
    return undefined;
  }

  async proposeSubagentDispatch(snapshot: SubagentDispatchSnapshot, signal: AbortSignal): Promise<SubagentDispatchProposal> {
    let merged: SubagentDispatchProposal = {};
    for (const entry of this.dispatchAdvisors.list()) {
      const proposal = await this.dispatchAdvisors.invoke(entry, handler => handler(snapshot, signal), signal);
      if (proposal === undefined) continue;
      merged = { ...merged, ...proposal };
    }
    return merged;
  }

  async proposeSubagentReturn(context: Parameters<IPluginExtensionPortRegistryReader['proposeSubagentReturn']>[0]): Promise<SubagentReturnProposal> {
    let merged: SubagentReturnProposal = {};
    for (const entry of this.returnAdvisors.list()) {
      const proposal = await this.returnAdvisors.invoke(entry, handler => handler(context), context.signal);
      if (proposal === undefined) continue;
      merged = { ...merged, ...proposal };
    }
    return merged;
  }

  dynamicExecutor(protocol: AgentExecutorProtocol): DynamicExecutorContribution | undefined {
    return this.executors.find(entry => entry.value.protocol === protocol)?.value;
  }

  dynamicExecutors(): readonly DynamicExecutorContribution[] {
    return this.executors.list().map(entry => entry.value);
  }

  createDynamicExecutorSession(contribution: DynamicExecutorContribution, context: AgentExecutorContext): AgentExecutorSession {
    const entry = this.executors.find(candidate => candidate.value === contribution);
    if (entry === undefined) throw new Error(`Dynamic executor "${contribution.descriptor.id}" is no longer active`);
    return this.executors.trackSession(entry, contribution.provider.create(context));
  }

}

function mergeRecords<T extends Readonly<Record<string, unknown>> | undefined>(left: T, right: T): T {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return { ...left, ...right };
}

registerScopedService(
  LifecycleScope.App,
  IPluginExtensionPortRegistry,
  PluginExtensionPortRegistryService,
  ScopeActivation.OnScopeCreated,
  'pluginExtensionPorts',
);
