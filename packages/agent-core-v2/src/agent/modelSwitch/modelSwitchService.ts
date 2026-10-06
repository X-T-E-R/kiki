import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService, type PreparedModelSwitchBinding } from '#/agent/profile/profile';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { contextRevisionKey } from '#/agent/contextMemory/contextOps';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { buildContextCompactionShape, buildCompactionSummaryText } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { contextWindowEpochKey } from '#/agent/fullCompaction/windowEpoch';
import { historyPointer } from '#/agent/fullCompaction/relayPackage';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentTaskService } from '#/agent/task/task';
import { goalKey } from '#/agent/goal/goalOps';
import { permissionModeKey } from '#/agent/permissionMode/permissionModeOps';
import { planKey } from '#/features/plan/planOps';
import { IAgentMemorySnapshot, memoryEntryReference } from '#/app/memory/memorySnapshot';
import { readTodoState, todoKey } from '#/session/todo/todoOps';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { directChildAgents } from '#/session/agentCollaboration/directChildren';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IAgentModelSwitchService, type ModelSwitchInput, type ModelSwitchExecuteOptions, type ModelSwitchReceipt } from './modelSwitch';
import { AgentModelSwitch, modelSwitchCompletionsKey, modelSwitchContinuityKey } from './modelSwitchOps';
import { buildFreshPackage, type FreshPackageInput } from './freshPackage';

interface ActiveSwitch {
  readonly input: ModelSwitchInput;
  readonly quiescence: IDisposable;
  receipt: ModelSwitchReceipt;
  promise?: Promise<ModelSwitchReceipt>;
  binding?: PreparedModelSwitchBinding;
  event?: AgentModelSwitch;
  confirmed: boolean;
}

export class AgentModelSwitchService extends Disposable implements IAgentModelSwitchService {
  declare readonly _serviceBrand: undefined;
  private readonly changes = this._register(new Emitter<ModelSwitchReceipt>());
  readonly onDidChange = this.changes.event;
  private active?: ActiveSwitch;
  private readonly confirmedCompletions = new Map<string, ModelSwitchReceipt>();

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @IAgentTokenCountingService private readonly tokens: IAgentTokenCountingService,
    @IAgentLLMRequesterService private readonly requester: IAgentLLMRequesterService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentMemorySnapshot private readonly memory: IAgentMemorySnapshot,
    @ISessionContext private readonly session: ISessionContext,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
  ) {
    super();
    this.states.contributeState(modelSwitchCompletionsKey);
    this.states.contributeState(modelSwitchContinuityKey);
    this._register({ dispose: () => this.active?.quiescence.dispose() });
  }

  get(operationId: string): ModelSwitchReceipt | undefined {
    if (this.active?.input.operationId === operationId) return this.active.receipt;
    const receipt = this.states.get(modelSwitchCompletionsKey).get(operationId)?.receipt;
    return receipt === undefined || this.confirmedCompletions.get(operationId) === receipt ? receipt : { ...receipt, state: 'preparing' };
  }

  async execute(input: ModelSwitchInput, options: ModelSwitchExecuteOptions = {}): Promise<ModelSwitchReceipt> {
    if (!input.operationId.trim() || !input.model.trim() || !['direct', 'compact', 'fresh'].includes(input.mode)) {
      return Promise.reject(new Error2(ErrorCodes.REQUEST_INVALID, 'Model switch requires operationId, model and an explicit direct/compact/fresh mode.'));
    }
    if (this.active !== undefined) {
      if (this.active.input.operationId !== input.operationId) {
        return Promise.reject(new Error2(ErrorCodes.TURN_AGENT_BUSY, 'The agent is preparing or recovering another model switch.'));
      }
      this.assertSameInput(this.active.input, input);
      if (this.active.promise !== undefined) return this.active.promise;
      const active = this.active;
      active.promise = this.finish(active).finally(() => { active.promise = undefined; });
      return active.promise;
    }
    const completed = this.states.get(modelSwitchCompletionsKey).get(input.operationId);
    if (completed !== undefined) {
      this.assertSameInput(completed.input, input);
      if (this.confirmedCompletions.get(input.operationId) === completed.receipt) return completed.receipt;
    }
    const quiescence = this.compaction.isCompacting() ? undefined : this.loop.tryAcquireQuiescence();
    if (quiescence === undefined) return Promise.reject(new Error2(ErrorCodes.TURN_AGENT_BUSY, 'Model switching requires an idle agent.'));
    const receipt: ModelSwitchReceipt = completed === undefined
      ? { operationId: input.operationId, agentId: this.scope.agentId, state: 'preparing', fromModel: this.profile.getModel(), toModel: input.model, mode: input.mode }
      : { ...completed.receipt, state: 'preparing' };
    const active: ActiveSwitch = { input: { ...input }, quiescence, receipt, confirmed: false };
    this.active = active;
    active.promise = Promise.resolve().then(() => completed === undefined ? this.prepareAndCommit(active, options) : this.finish(active)).finally(() => { active.promise = undefined; });
    this.changes.fire(receipt);
    return active.promise;
  }

  private assertSameInput(previous: ModelSwitchInput, input: ModelSwitchInput): void {
    if (previous.model !== input.model || previous.mode !== input.mode || previous.thinking !== input.thinking) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'This model switch operationId already belongs to a different model, mode or effort.');
    }
  }

  private async prepareAndCommit(active: ActiveSwitch, options: ModelSwitchExecuteOptions): Promise<ModelSwitchReceipt> {
    const signal = options.signal ?? new AbortController().signal;
    try {
      signal.throwIfAborted();
      const revision = this.states.get(contextRevisionKey);
      const history = this.context.get();
      const oldEpoch = this.states.get(contextWindowEpochKey);
      const binding = options.binding ?? await this.profile.prepareModelSwitchBinding(active.input.model, active.input.thinking);
      active.binding = binding;
      active.receipt = { ...active.receipt, toModel: binding.model };
      this.changes.fire(active.receipt);
      const maxContextTokens = binding.maxContextTokens;
      const reservedTokens = binding.reservedTokens;
      if (active.input.mode !== 'direct' && (maxContextTokens === undefined || reservedTokens === undefined)) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'This executor does not support rebuilding a model switch context window.');
      }
      const summary = active.input.mode === 'compact' ? await this.compaction.prepareModelSwitchSummary(history, signal) : undefined;
      signal.throwIfAborted();
      let messages: readonly ContextMessage[] | undefined;
      let contextTokens: number | undefined;
      if (active.input.mode !== 'direct' && maxContextTokens !== undefined && reservedTokens !== undefined) {
        const overhead = this.tokens.requestSize({ systemPrompt: binding.config.systemPrompt ?? this.profile.getSystemPrompt(),
          tools: this.toolSelect.shapeTools(this.tools.list()).filter((tool) => tool.deferred !== true).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? {} })), messages: [] });
        const budget = maxContextTokens - reservedTokens - overhead;
        if (budget <= 0) throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, 'The target model cannot fit its system prompt, tools and reserved output space.');
        const summaryText = summary === undefined ? '' : buildCompactionSummaryText(summary);
        const state = await this.readPackageState(history, oldEpoch, budget - this.tokens.estimateText(summaryText));
        const empty = history.length === 0 && !state.notes && state.todos.length === 0 && state.goal === undefined
          && !state.taskDescription && !state.children?.length && !state.tasks?.length;
        const fresh = empty ? [] : buildFreshPackage({ ...state, includeLatestHumanInput: active.input.mode === 'fresh' });
        if (empty) {
          messages = [];
        } else if (active.input.mode === 'compact') {
          const text = [summaryText, this.textOf(fresh)].filter(Boolean).join('\n\n');
          const remaining = Math.max(0, budget - this.tokens.estimateText(text) - 64);
          messages = buildContextCompactionShape(history, { summary: text, contextSummary: text,
            compactedCount: history.length, tokensBefore: this.tokens.get().size,
            legacyTail: false, userBudget: { max: Math.min(20_000, remaining), head: Math.min(2_000, remaining) },
          }, { text: (text) => this.tokens.estimateText(text), message: (message) => this.tokens.estimateMessage(message),
            messages: (messages) => this.tokens.estimateMessages(messages) }).messages.map(portableMessage);
        } else {
          messages = fresh;
        }
        contextTokens = overhead + this.tokens.estimateMessages(messages);
        if (contextTokens + reservedTokens > maxContextTokens) throw new Error2(ErrorCodes.CONTEXT_OVERFLOW, 'The prepared model switch context exceeds the target model capacity.');
      }
      signal.throwIfAborted();
      binding.assertCurrent();
      if (revision !== this.states.get(contextRevisionKey) || history !== this.context.get()) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'The active context changed during model switch preparation. Retry against its current context.');
      }
      active.event = new AgentModelSwitch({ operationId: active.input.operationId, input: active.input, agentId: this.scope.agentId,
        fromModel: active.receipt.fromModel, toModel: binding.model, thinking: binding.thinking, mode: active.input.mode,
        config: binding.config, contextRevision: revision, oldEpoch, newEpoch: messages === undefined ? oldEpoch : oldEpoch + 1,
        summaryGenerated: summary !== undefined, context: messages, contextTokens, previousMessageCount: history.length });
      if (!AgentModelSwitch.schema.safeParse(active.event.serialize()).success) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, 'The prepared model switch binding and context are inconsistent.');
      }
      await this.dispatcher.dispatch(active.event);
      return await this.finish(active);
    } catch (error) {
      if (this.states.get(modelSwitchCompletionsKey).has(active.input.operationId)) return this.recovering(active, error);
      active.receipt = { ...active.receipt, state: signal.aborted ? 'cancelled' : 'failed', error: this.errorPayload(error) };
      this.active = undefined;
      active.quiescence.dispose();
      this.changes.fire(active.receipt);
      return active.receipt;
    }
  }

  private async finish(active: ActiveSwitch): Promise<ModelSwitchReceipt> {
    try {
      await this.dispatcher.flush();
      const completed = this.states.get(modelSwitchCompletionsKey).get(active.input.operationId);
      if (completed === undefined) throw new Error2(ErrorCodes.STORAGE_DECODE_FAILED, 'Model switch completion is unavailable; restore the agent journal before continuing.');
      if (active.binding !== undefined) await active.binding.syncMetadata();
      else await this.profile.syncBindingMetadata();
      await this.syncMetadata();
      if (!active.confirmed) {
        this.requester.invalidatePromptSnapshots();
        if (active.event?.context !== undefined) await this.dispatcher.dispatch(new ContextSpliced({ start: 0,
          deleteCount: active.event.previousMessageCount, messages: [...active.event.context], tokens: active.event.contextTokens }));
        this.profile.republishStatus();
        this.profile.publishBindingAdvisories();
        active.confirmed = true;
      }
      active.receipt = completed.receipt;
      this.confirmedCompletions.set(active.input.operationId, completed.receipt);
      this.active = undefined;
      this.changes.fire(active.receipt);
      active.quiescence.dispose();
      return active.receipt;
    } catch (error) {
      return this.recovering(active, error);
    }
  }

  private recovering(active: ActiveSwitch, error: unknown): ModelSwitchReceipt {
    active.receipt = { ...active.receipt, state: 'preparing', error: { ...this.errorPayload(error), code: error instanceof ModelSwitchMetadataMissingError ? 'agent_metadata_missing' : isError2(error) ? error.code : ErrorCodes.STORAGE_IO_FAILED } };
    this.changes.fire(active.receipt);
    return active.receipt;
  }

  private errorPayload(error: unknown): NonNullable<ModelSwitchReceipt['error']> {
    return { code: isError2(error) ? error.code : ErrorCodes.REQUEST_INVALID, message: error instanceof Error ? error.message : String(error) };
  }

  private textOf(messages: readonly ContextMessage[]): string {
    return messages.flatMap((message) => message.content.flatMap((part) => part.type === 'text' ? [part.text] : [])).join('\n');
  }

  private async readPackageState(history: readonly ContextMessage[], epoch: number, maxTokens: number): Promise<FreshPackageInput> {
    const agentId = this.scope.agentId;
    const previous = this.states.has(todoKey) ? readTodoState(this.states.get(todoKey)) : { items: [] };
    const [meta, memoryEntries, memoryReferences] = await Promise.all([
      this.metadata.read(), this.memory.liveSessionEntries(),
      this.memory.resolveReferences([previous.notes?.directives, previous.notes?.decided].filter(Boolean).join('\n')),
    ]);
    const todo = this.states.has(todoKey) ? readTodoState(this.states.get(todoKey)) : { items: [] };
    const continuity = this.states.get(modelSwitchContinuityKey);
    const base = { history, compactCount: history.length, agentId, sessionId: this.session.sessionId, epoch,
      notes: todo.notes, meta: todo.notesMeta, todos: todo.items, estimateText: (text: string) => this.tokens.estimateText(text) };
    const description = continuity.taskDescription;
    return { ...base, maxTokens, estimateMessages: (messages) => this.tokens.estimateMessages(messages),
      latestHumanInput: continuity.latestHumanInput,
      taskDescription: description === undefined ? undefined : `${historyPointer(base, description.source)}\n${description.truncated ? '[Original input preview; see history for complete text.]\n' : ''}${description.text}`,
      goal: this.states.has(goalKey) && this.states.get(goalKey) !== null ? JSON.stringify(this.states.get(goalKey)) : undefined,
      children: directChildAgents(meta.agents, agentId).filter((child) => child.meta.status === undefined)
        .slice(0, 40).map((child) => `- ${child.agentId} (${child.name ?? child.profileName ?? 'unnamed'}) · model ${child.meta.model ?? 'unknown'} · status tracked by AgentList`),
      tasks: this.tasks.list(false, 40).map((task) => `- ${task.taskId} (${task.kind}, ${task.status}): ${task.description}\n  owner ${task.ownerAgentId ?? agentId} · turn ${task.ownerTurnId ?? 'unknown'} · receipt ${task.receipt?.path ?? 'not committed'}`),
      stateViews: [
        this.states.has(permissionModeKey) ? `## Permission state\n${this.states.get(permissionModeKey)}` : '',
        this.states.has(planKey) ? `## Plan state\n${JSON.stringify(this.states.get(planKey))}` : '',
      ].filter(Boolean),
      memoryEntries: memoryEntries.map((entry) => memoryEntryReference(entry)), memoryReferences,
    };
  }

  private async syncMetadata(): Promise<void> {
    const binding = this.profile.data();
    const contextTokens = this.tokens.get().size;
    const epoch = this.states.get(contextWindowEpochKey);
    let found = false;
    await this.metadata.updateAgent(this.scope.agentId, (current) => {
      found = true;
      return { ...current, model: binding.modelAlias, thinkingEffort: binding.thinkingLevel,
        executor: binding.executorId ?? 'native', executorProtocol: binding.executorProtocol, allowKikiSubagents: binding.allowKikiSubagents,
        contextTokens, labels: { ...current.labels, contextWindowEpoch: String(epoch) } };
    });
    if (!found) throw new ModelSwitchMetadataMissingError('The model switch is committed, but the agent metadata entry is missing. Restore the agent through its lifecycle before retrying this operation; a closed agent must not continue.');
  }
}

class ModelSwitchMetadataMissingError extends Error {}

registerScopedService(LifecycleScope.Agent, IAgentModelSwitchService, AgentModelSwitchService, ScopeActivation.OnScopeCreated, 'modelSwitch');

function portableMessage(message: ContextMessage): ContextMessage {
  return { role: 'user', toolCalls: [], id: message.id, source: message.source, origin: message.origin,
    content: message.content.flatMap((part): import('#/kosong/contract/message').ContentPart[] => {
      switch (part.type) {
        case 'text': return [{ type: 'text', text: part.text }];
        case 'image_url': return [{ type: 'image_url', imageUrl: { url: part.imageUrl.url, id: part.imageUrl.id, name: part.imageUrl.name } }];
        case 'audio_url': return [{ type: 'audio_url', audioUrl: { url: part.audioUrl.url, id: part.audioUrl.id } }];
        case 'video_url': return [{ type: 'video_url', videoUrl: { url: part.videoUrl.url, id: part.videoUrl.id, name: part.videoUrl.name } }];
        case 'think': return [];
      }
    }) };
}
