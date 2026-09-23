import type { TranscriptFact } from './reducer';
import { projectTranscriptUserOrigin } from '../contract/origin';
import type { AttachmentSource } from '../model/attachment';
import type { MessageDelivery, ToolCallFrame } from '../model/frame';
import { projectInteractionEndState, type TranscriptInteraction } from '../model/interaction';
import type { GoalMeta, GoalStatus } from '../model/meta';
import type { TranscriptPrompt, TranscriptPromptAppendTiming } from '../model/prompt';
import type { TranscriptTask } from '../model/task';
import type { TodoItem } from '../model/todo';
import type { StepHeader, TurnHeader, TranscriptOperation } from '../ops/operation';
import type { StepUsage, TranscriptTurnExecution, TurnOrigin } from '../model/turn';

export interface TranscriptWireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

export interface TranscriptWireAdapterLookups {
  readonly turn?: (turnId: string) => TurnHeader | undefined;
  readonly tool?: (toolCallId: string) =>
    | { readonly turnId: string; readonly stepId: string; readonly frame: ToolCallFrame }
    | undefined;
  readonly task?: (taskId: string) => TranscriptTask | undefined;
}

export function taskNotificationFrameId(sourceId: string): string {
  return `task-notified:${sourceId}`;
}

interface PendingSteerMedia {
  readonly kind: 'image' | 'video' | 'audio';
  readonly source?: AttachmentSource;
  readonly name?: string;
}

export interface PendingSteer {
  readonly promptId: string;
  readonly explicitPromptId?: string;
  readonly text: string;
  readonly media: readonly PendingSteerMedia[];
  readonly revision: number;
  readonly provenance: {
    readonly source: 'legacy-wire' | 'engine';
    readonly recordOrdinal?: number;
  };
  readonly origin: unknown;
}

interface DeliveryUndoRecord {
  readonly ordinal: number;
  readonly anchor: boolean;
}

interface FrameRecord {
  readonly ordinal: number;
  readonly operation: Extract<TranscriptOperation, { op: 'frame.upsert' }>;
}

interface MessageProjectionCheckpoint {
  readonly deliveries: readonly [string, DeliveryUndoRecord][];
  readonly frames: readonly [string, FrameRecord][];
  readonly turns: readonly [string, number][];
  readonly steps: readonly [string, number][];
}

export interface TranscriptWireAdapterCheckpoint {
  readonly version: 1 | 2;
  readonly agentId: string;
  readonly turns: readonly string[];
  readonly turnIds: readonly string[];
  readonly turnHeaders: readonly [string, TurnHeader][];
  readonly steps: readonly [string, { readonly stepId: string; readonly ordinal: number }][];
  readonly turnIdByStepId: readonly [string, string][];
  readonly stepHeaders: readonly [string, StepHeader][];
  readonly stepIdsByTurn: readonly [string, readonly string[]][];
  readonly runningStepIdsByTurn: readonly [string, readonly string[]][];
  readonly tools: readonly [string, { readonly turnId: string; readonly stepId: string; readonly frame: ToolCallFrame }][];
  readonly toolIdsByTurn: readonly [string, readonly string[]][];
  readonly runningToolIdsByTurn: readonly [string, readonly string[]][];
  readonly stepUsages: readonly [string, readonly StepUsage[]][];
  readonly tasks: readonly [string, TranscriptTask][];
  readonly subagentTaskIds: readonly [string, string][];
  readonly replayedSubagentSpawns: readonly [string, string][];
  readonly interactions: readonly [string, TranscriptInteraction][];
  readonly canonicalTurns: readonly string[];
  readonly undoAnchors: readonly string[];
  readonly turnOwnedItemIds: readonly [string, readonly string[]][];
  readonly steeredMessageIds: readonly string[];
  readonly pendingSteers: readonly [string, readonly PendingSteer[]][];
  readonly pendingTaskNotifications: readonly [string, readonly TranscriptWireRecord[]][];
  readonly projectedTaskNotificationIds: readonly string[];
  readonly deliveredTaskNotifications?: readonly [string, string][];
  readonly unpairedSteerCredits: readonly [string, readonly [string, number][]][];
  readonly executions: readonly [string, TranscriptTurnExecution][];
  readonly goal?: GoalMeta;
  readonly plan?: { readonly reviewPath?: string; readonly version?: number };
  readonly recordOrdinal: number;
  readonly legacyTurnOrdinal: number;
  readonly lastRecordTime?: number;
  readonly currentTurnId?: string;
  readonly currentPromptId?: string;
  readonly prompts?: readonly [string, TranscriptPrompt][];
  readonly hiddenPromptIds?: readonly string[];
  readonly deliveries?: readonly [string, MessageDelivery][];
  readonly messageProjection?: MessageProjectionCheckpoint;
}

export class TranscriptWireAdapter {
  readonly #turns: string[] = [];
  readonly #turnIds = new Set<string>();
  readonly #turnHeaders = new Map<string, TurnHeader>();
  readonly #steps = new Map<string, { stepId: string; ordinal: number }>();
  readonly #turnIdByStepId = new Map<string, string>();
  readonly #stepHeaders = new Map<string, StepHeader>();
  readonly #stepIdsByTurn = new Map<string, Set<string>>();
  readonly #runningStepIdsByTurn = new Map<string, Set<string>>();
  readonly #tools = new Map<string, { turnId: string; stepId: string; frame: ToolCallFrame }>();
  readonly #toolIdsByTurn = new Map<string, Set<string>>();
  readonly #runningToolIdsByTurn = new Map<string, Set<string>>();
  readonly #stepUsages = new Map<string, StepUsage[]>();
  readonly #tasks = new Map<string, TranscriptTask>();
  readonly #subagentTaskIds = new Map<string, string>();
  readonly #replayedSubagentSpawns = new Map<string, string>();
  readonly #interactions = new Map<string, TranscriptInteraction>();
  readonly #canonicalTurns = new Set<string>();
  readonly #undoAnchors = new Set<string>();
  readonly #turnOwnedItemIds = new Map<string, string[]>();
  readonly #steeredMessageIds = new Set<string>();
  readonly #pendingSteers = new Map<string, PendingSteer[]>();
  readonly #pendingTaskNotifications = new Map<string, TranscriptWireRecord[]>();
  readonly #projectedTaskNotificationIds = new Set<string>();
  readonly #deliveredTaskNotifications = new Map<string, string>();
  readonly #unpairedSteerCredits = new Map<string, Map<string, number>>();
  readonly #executions = new Map<string, TranscriptTurnExecution>();
  readonly #prompts = new Map<string, TranscriptPrompt>();
  readonly #hiddenPromptIds = new Set<string>();
  readonly #deliveries = new Map<string, MessageDelivery>();
  readonly #deliveryUndoRecords = new Map<string, DeliveryUndoRecord>();
  readonly #frameRecords = new Map<string, FrameRecord>();
  readonly #turnRecordOrdinals = new Map<string, number>();
  readonly #stepRecordOrdinals = new Map<string, number>();
  #goal: GoalMeta | undefined;
  #plan: { readonly reviewPath?: string; readonly version?: number } | undefined;
  #recordOrdinal = 0;
  #legacyTurnOrdinal = 0;
  #lastRecordTime: number | undefined;
  #currentTurnId: string | undefined;
  #currentPromptId: string | undefined;

  constructor(
    readonly agentId: string,
    readonly lookups?: TranscriptWireAdapterLookups,
  ) {}

  checkpoint(): TranscriptWireAdapterCheckpoint {
    return {
      version: 2,
      agentId: this.agentId,
      turns: [...this.#turns],
      turnIds: [...this.#turnIds],
      turnHeaders: [...this.#turnHeaders],
      steps: [...this.#steps],
      turnIdByStepId: [...this.#turnIdByStepId],
      stepHeaders: [...this.#stepHeaders],
      stepIdsByTurn: [...this.#stepIdsByTurn].map(([key, value]) => [key, [...value]]),
      runningStepIdsByTurn: [...this.#runningStepIdsByTurn].map(([key, value]) => [key, [...value]]),
      tools: [...this.#tools],
      toolIdsByTurn: [...this.#toolIdsByTurn].map(([key, value]) => [key, [...value]]),
      runningToolIdsByTurn: [...this.#runningToolIdsByTurn].map(([key, value]) => [key, [...value]]),
      stepUsages: [...this.#stepUsages],
      tasks: [...this.#tasks],
      subagentTaskIds: [...this.#subagentTaskIds],
      replayedSubagentSpawns: [...this.#replayedSubagentSpawns],
      interactions: [...this.#interactions],
      canonicalTurns: [...this.#canonicalTurns],
      undoAnchors: [...this.#undoAnchors],
      turnOwnedItemIds: [...this.#turnOwnedItemIds],
      steeredMessageIds: [...this.#steeredMessageIds],
      pendingSteers: [...this.#pendingSteers],
      pendingTaskNotifications: [...this.#pendingTaskNotifications],
      projectedTaskNotificationIds: [...this.#projectedTaskNotificationIds],
      deliveredTaskNotifications: [...this.#deliveredTaskNotifications],
      unpairedSteerCredits: [...this.#unpairedSteerCredits].map(([key, value]) => [key, [...value]]),
      executions: [...this.#executions],
      goal: this.#goal,
      plan: this.#plan,
      recordOrdinal: this.#recordOrdinal,
      legacyTurnOrdinal: this.#legacyTurnOrdinal,
      lastRecordTime: this.#lastRecordTime,
      currentTurnId: this.#currentTurnId,
      currentPromptId: this.#currentPromptId,
      prompts: [...this.#prompts],
      hiddenPromptIds: [...this.#hiddenPromptIds],
      deliveries: [...this.#deliveries],
      messageProjection: {
        deliveries: [...this.#deliveryUndoRecords], frames: [...this.#frameRecords],
        turns: [...this.#turnRecordOrdinals], steps: [...this.#stepRecordOrdinals],
      },
    };
  }

  restore(checkpoint: TranscriptWireAdapterCheckpoint): void {
    if ((checkpoint.version !== 1 && checkpoint.version !== 2) || checkpoint.agentId !== this.agentId) {
      throw new Error('transcript adapter checkpoint is incompatible');
    }
    this.#turns.splice(0, this.#turns.length, ...checkpoint.turns);
    replaceSet(this.#turnIds, checkpoint.turnIds);
    replaceMap(this.#turnHeaders, checkpoint.turnHeaders);
    replaceMap(this.#steps, checkpoint.steps);
    replaceMap(this.#turnIdByStepId, checkpoint.turnIdByStepId);
    replaceMap(this.#stepHeaders, checkpoint.stepHeaders);
    replaceSetMap(this.#stepIdsByTurn, checkpoint.stepIdsByTurn);
    replaceSetMap(this.#runningStepIdsByTurn, checkpoint.runningStepIdsByTurn);
    replaceMap(this.#tools, checkpoint.tools);
    replaceSetMap(this.#toolIdsByTurn, checkpoint.toolIdsByTurn);
    replaceSetMap(this.#runningToolIdsByTurn, checkpoint.runningToolIdsByTurn);
    replaceMap(this.#stepUsages, checkpoint.stepUsages.map(([key, value]) => [key, [...value]]));
    replaceMap(this.#tasks, checkpoint.tasks);
    replaceMap(this.#subagentTaskIds, checkpoint.subagentTaskIds);
    replaceMap(this.#replayedSubagentSpawns, checkpoint.replayedSubagentSpawns);
    replaceMap(this.#interactions, checkpoint.interactions);
    replaceSet(this.#canonicalTurns, checkpoint.canonicalTurns);
    replaceSet(this.#undoAnchors, checkpoint.undoAnchors);
    replaceMap(this.#turnOwnedItemIds, checkpoint.turnOwnedItemIds.map(([key, value]) => [key, [...value]]));
    replaceSet(this.#steeredMessageIds, checkpoint.steeredMessageIds);
    replaceMap(this.#pendingSteers, checkpoint.pendingSteers.map(([key, value]) => [key, [...value]]));
    replaceMap(
      this.#pendingTaskNotifications,
      checkpoint.pendingTaskNotifications.map(([key, value]) => [key, [...value]]),
    );
    replaceSet(this.#projectedTaskNotificationIds, checkpoint.projectedTaskNotificationIds);
    replaceMap(this.#deliveredTaskNotifications, checkpoint.deliveredTaskNotifications ?? []);
    replaceMap(
      this.#unpairedSteerCredits,
      checkpoint.unpairedSteerCredits.map(([key, value]) => [key, new Map(value)]),
    );
    replaceMap(this.#executions, checkpoint.executions);
    this.#goal = checkpoint.goal;
    this.#plan = checkpoint.plan;
    this.#recordOrdinal = checkpoint.recordOrdinal;
    this.#legacyTurnOrdinal = checkpoint.legacyTurnOrdinal;
    this.#lastRecordTime = checkpoint.lastRecordTime;
    this.#currentTurnId = checkpoint.currentTurnId;
    this.#currentPromptId = checkpoint.currentPromptId;
    replaceMap(this.#prompts, checkpoint.prompts ?? []);
    replaceSet(this.#hiddenPromptIds, checkpoint.hiddenPromptIds ?? []);
    replaceMap(this.#deliveries, checkpoint.deliveries ?? []);
    replaceMap(this.#deliveryUndoRecords, checkpoint.messageProjection?.deliveries ?? []);
    replaceMap(this.#frameRecords, checkpoint.messageProjection?.frames ?? []);
    replaceMap(this.#turnRecordOrdinals, checkpoint.messageProjection?.turns ?? []);
    replaceMap(this.#stepRecordOrdinals, checkpoint.messageProjection?.steps ?? []);
  }

  add(record: TranscriptWireRecord): TranscriptFact[] {
    const ordinal = this.#recordOrdinal++;
    if (record.time !== undefined) this.#lastRecordTime = record.time;
    const operations = this.operations(record, ordinal);
    if (operations.length === 0) return [];
    this.rememberProjection(operations, ordinal);
    return [
      {
        factId: factId(record, ordinal),
        durability: durableRecord(record.type) ? 'durable' : 'transient',
        operations,
      },
    ];
  }

  private rememberProjection(operations: readonly TranscriptOperation[], ordinal: number): void {
    for (const operation of operations) {
      if (operation.op === 'turn.upsert' && !this.#turnRecordOrdinals.has(operation.turn.turnId)) {
        this.#turnRecordOrdinals.set(operation.turn.turnId, ordinal);
      } else if (operation.op === 'step.upsert' && !this.#stepRecordOrdinals.has(operation.step.stepId)) {
        this.#stepRecordOrdinals.set(operation.step.stepId, ordinal);
      } else if (operation.op === 'frame.upsert') {
        const key = `${operation.turnId}\0${operation.stepId}\0${operation.frame.frameId}`;
        const previous = this.#frameRecords.get(key);
        this.#frameRecords.set(key, { ordinal: previous?.ordinal ?? ordinal, operation });
      }
    }
  }

  finish(): TranscriptFact[] {
    const operations: TranscriptOperation[] = [];
    const endedAt = isoOf(this.#lastRecordTime);
    for (const [toolCallId, hit] of this.#tools) {
      if (hit.frame.state !== 'running') continue;
      const frame: ToolCallFrame = { ...hit.frame, state: 'interrupted', endedAt };
      this.storeTool(toolCallId, { ...hit, frame });
      operations.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame });
    }
    for (const [stepId, previous] of this.#stepHeaders) {
      if (previous.state !== 'running') continue;
      const step: StepHeader = { ...previous, state: 'interrupted', endedAt };
      this.storeStep(stepId, step);
      operations.push({ op: 'step.upsert', turnId: step.turnId, step });
    }
    for (const [turnId, previous] of this.#turnHeaders) {
      if (previous.state !== 'running') continue;
      const turn: TurnHeader = { ...previous, state: 'cancelled', endedAt };
      this.#turnHeaders.set(turnId, turn);
      operations.push({ op: 'turn.upsert', turn });
    }
    for (const [interactionId, interaction] of this.#interactions) {
      if (interaction.state !== 'pending') continue;
      const cancelled = { ...interaction, state: 'cancelled' as const };
      this.#interactions.set(interactionId, cancelled);
      operations.push({ op: 'interaction.upsert', interaction: cancelled });
    }
    return operations.length === 0
      ? []
      : [
          {
            factId: `wire:v2:finish:${this.agentId}`,
            durability: 'transient',
            operations,
          },
        ];
  }

  private operations(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    if (record.type === 'turn.prompt') return this.turnPrompt(record, ordinal);
    if (record.type === 'turn.steer') return this.turnSteer(record, ordinal);
    if (record.type === 'context.append_message') return this.legacyMessage(record, ordinal);
    if (record.type === 'context.append_loop_event') {
      const event = objectOf(record['event']);
      return event === undefined ? [] : this.loopEvent(event, ordinal, record.time);
    }
    if (record.type === 'turn.ended') return this.turnEnded(record);
    if (record.type === 'context.undo') return this.undo(numberOf(record['count']) ?? 1);
    if (record.type === 'context.clear') return this.removeTurns(this.#turns.length);
    if (record.type === 'context.apply_compaction') {
      return [
        {
          op: 'marker.upsert',
          item: {
            kind: 'marker',
            markerId: stringOf(record['id']) ?? `wire:v2:r${ordinal}:compaction`,
            marker: 'compaction',
            payload: record,
            at: isoOf(record.time),
          },
        },
      ];
    }
    if (record.type.startsWith('prompt.')) return this.promptRecord(record);
    return this.supplemental(record, ordinal);
  }

  private promptRecord(record: TranscriptWireRecord): TranscriptOperation[] {
    const promptId = stringOf(record['promptId']) ?? stringOf(record['activePromptId']);
    if (promptId === undefined) return [];
    if (record.type === 'prompt.enqueued') {
      const message = objectOf(record['message']);
      const originKind = stringOf(objectOf(message?.['origin'])?.['kind']) ?? 'user';
      if (originKind !== 'user') {
        this.#hiddenPromptIds.add(promptId);
        return [];
      }
      const prompt: TranscriptPrompt = {
        promptId,
        status: 'queued',
        userMessageId: stringOf(record['userMessageId']) ?? stringOf(message?.['id']),
        content: projectPromptContent(message?.['content']),
        createdAt: promptRecordTime(record, ['createdAt']) ?? isoOf(record.time) ?? new Date(0).toISOString(),
        queuePosition: numberOf(record['queueIndex']),
        appendTiming: promptAppendTimingOf(record['appendTiming']),
        revision: numberOf(record['revision']),
      };
      return [this.storePrompt(prompt)];
    }
    if (this.#hiddenPromptIds.has(promptId) && record.type !== 'prompt.steered') return [];
    const previous = this.#prompts.get(promptId);
    if (record.type === 'prompt.replaced') {
      const content = projectPromptContent(record['content']);
      return [
        this.storePrompt({
          ...promptOrMinimal(previous, promptId, record),
          status: previous?.status ?? 'queued',
          content: content.length > 0 ? content : previous?.content,
          revision: numberOf(record['revision']) ?? previous?.revision,
        }),
      ];
    }
    if (record.type === 'prompt.timing_changed') {
      return [
        this.storePrompt({
          ...promptOrMinimal(previous, promptId, record),
          appendTiming: promptAppendTimingOf(record['appendTiming']) ?? previous?.appendTiming,
          revision: numberOf(record['revision']) ?? previous?.revision,
        }),
      ];
    }
    if (record.type === 'prompt.moved') {
      const ids = stringArrayOf(record['queuedPromptIds']);
      if (ids.length === 0) return [];
      const operations: TranscriptOperation[] = [];
      for (const [queuePosition, id] of ids.entries()) {
        if (this.#hiddenPromptIds.has(id)) continue;
        const prior = this.#prompts.get(id) ?? minimalPrompt(id, record);
        operations.push(
          this.storePrompt({
            ...prior,
            status: prior.status === 'running' ? prior.status : 'queued',
            queuePosition,
          }),
        );
      }
      return operations;
    }
    if (record.type === 'prompt.launch_committed') {
      return [
        this.storePrompt({
          ...promptOrMinimal(previous, promptId, record),
          status: 'running',
          queuePosition: undefined,
          revision: numberOf(record['revision']) ?? previous?.revision,
        }),
      ];
    }
    if (record.type === 'prompt.completed') {
      const reason = stringOf(record['reason']);
      const status: TranscriptPrompt['status'] =
        reason === 'failed' || reason === 'blocked' ? reason : 'completed';
      return [
        this.storePrompt({
          ...promptOrMinimal(previous, promptId, record),
          status,
          finishedAt: promptRecordTime(record, ['finishedAt']) ?? previous?.finishedAt,
        }),
      ];
    }
    if (record.type === 'prompt.aborted') {
      return [
        this.storePrompt({
          ...promptOrMinimal(previous, promptId, record),
          status: 'aborted',
          finishedAt: promptRecordTime(record, ['abortedAt']) ?? previous?.finishedAt,
          abortedBeforeStart:
            record['beforeStart'] === true ? true : previous?.abortedBeforeStart,
        }),
      ];
    }
    if (record.type === 'prompt.steered') {
      const activePromptId = stringOf(record['activePromptId']) ?? promptId;
      const steeredAt = promptRecordTime(record, ['steeredAt']) ?? isoOf(record.time) ?? new Date(0).toISOString();
      const operations: TranscriptOperation[] = [];
      if (!this.#hiddenPromptIds.has(activePromptId)) {
        const content = projectPromptContent(record['content']);
        const activePrior =
          this.#prompts.get(activePromptId) ?? minimalPrompt(activePromptId, record);
        const active: TranscriptPrompt = {
          ...activePrior,
          status: isTerminalPromptStatus(activePrior.status) ? activePrior.status : 'running',
          content: content.length > 0 ? content : activePrior.content,
          steeredAt,
        };
        operations.push(this.storePrompt(active));
      }
      for (const id of stringArrayOf(record['promptIds'])) {
        if (id === activePromptId || this.#hiddenPromptIds.has(id)) continue;
        const prior = this.#prompts.get(id) ?? minimalPrompt(id, record);
        operations.push(
          this.storePrompt({ ...prior, status: 'completed', finishedAt: steeredAt, steeredAt }),
        );
      }
      return operations;
    }
    return [];
  }

  private storePrompt(prompt: TranscriptPrompt): TranscriptOperation {
    this.#prompts.set(prompt.promptId, prompt);
    return { op: 'prompt.upsert', prompt };
  }

  private supplemental(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    if (record.type === 'executor.turn.metadata') {
      const n = numberOf(record['turnId']);
      const execution = executionOf(record);
      if (n === undefined || execution === undefined) return [];
      const turnId = `t${n}`;
      this.#executions.set(turnId, execution);
      const previous = this.lookups?.turn?.(turnId);
      return previous === undefined
        ? []
        : [{ op: 'turn.upsert', turn: { ...previous, execution } }];
    }
    if (record.type === 'executor.plan.update') {
      return [
        {
          op: 'todo.upsert',
          todo: {
            todoId: 'external-plan',
            items: externalPlanItems(record['plan']),
            updatedAt: isoOf(record.time),
          },
        },
      ];
    }
    if (record.type === 'executor.plan.remove') {
      return [
        {
          op: 'todo.upsert',
          todo: { todoId: 'external-plan', items: [], updatedAt: isoOf(record.time) },
        },
      ];
    }
    if (record.type === 'executor.runtime.update' && record['kind'] === 'unknown') {
      return [this.marker(record, ordinal, 'executor.degradation')];
    }
    if (record.type === 'tools.update_store' && record['key'] === 'todo') {
      return [
        {
          op: 'todo.upsert',
          todo: {
            todoId: 'todo',
            items: todoItemsOf(record['value']),
            updatedAt: isoOf(record.time),
          },
        },
      ];
    }
    if (record.type === 'goal.create') {
      const status = stringOf(record['status']);
      this.#goal = {
        objective: stringOf(record['objective']) ?? '',
        status: isGoalStatus(status) ? status : 'active',
        completionCriterion: stringOf(record['completionCriterion']),
        followUpTiming: goalFollowUpTimingOf(record['followUpTiming']) ?? 'subagents_done',
        controlRevision: numberOf(record['controlRevision']) ?? 1,
        budgetUsed: 0,
      };
      return [
        { op: 'meta.merge', meta: { goal: this.#goal } },
        this.marker(record, ordinal, 'goal'),
      ];
    }
    if (record.type === 'goal.update') {
      if (this.#goal !== undefined) {
        const status = stringOf(record['status']);
        const tokenBudget = numberOf(objectOf(record['budgetLimits'])?.['tokenBudget']);
        const completionCriterion = record['completionCriterion'];
        this.#goal = {
          ...this.#goal,
          objective: stringOf(record['objective']) ?? this.#goal.objective,
          completionCriterion: completionCriterion === null
            ? undefined
            : stringOf(completionCriterion) ?? this.#goal.completionCriterion,
          followUpTiming: goalFollowUpTimingOf(record['followUpTiming']) ?? this.#goal.followUpTiming,
          controlRevision: numberOf(record['controlRevision']) ?? this.#goal.controlRevision,
          status: isGoalStatus(status) ? status : this.#goal.status,
          budgetUsed: numberOf(record['tokensUsed']) ?? this.#goal.budgetUsed,
          budgetLimit: tokenBudget ?? this.#goal.budgetLimit,
        };
      }
      return [
        { op: 'meta.merge', meta: { goal: this.#goal } },
        this.marker(record, ordinal, 'goal'),
      ];
    }
    if (record.type === 'goal.clear') {
      this.#goal = undefined;
      return [{ op: 'meta.merge', meta: { goal: null } }];
    }
    if (record.type === 'plan_mode.enter') {
      this.#plan = undefined;
      return [
        { op: 'meta.merge', meta: { modes: { plan: {} } } },
        this.marker(record, ordinal, 'plan.enter'),
      ];
    }
    if (record.type === 'plan_mode.exit' || record.type === 'plan_mode.cancel') {
      this.#plan = undefined;
      return [
        { op: 'meta.merge', meta: { modes: { plan: null } } },
        this.marker(record, ordinal, 'plan.exit'),
      ];
    }
    if (record.type === 'plan.revision') {
      this.#plan = {
        reviewPath: stringOf(record['path']),
        version: numberOf(record['version']),
      };
      return [
        { op: 'meta.merge', meta: { modes: { plan: this.#plan } } },
        this.marker(record, ordinal, 'plan.revision'),
      ];
    }
    if (record.type === 'swarm_mode.enter') {
      return [
        { op: 'meta.merge', meta: { modes: { swarm: {} } } },
        this.marker(record, ordinal, 'swarm.enter'),
      ];
    }
    if (record.type === 'swarm_mode.exit') {
      return [
        { op: 'meta.merge', meta: { modes: { swarm: null } } },
        this.marker(record, ordinal, 'swarm.exit'),
      ];
    }
    if (record.type === 'task.started' || record.type === 'task.terminated') {
      const info = objectOf(record['info']);
      const taskId = stringOf(info?.['taskId']);
      if (taskId === undefined) return [];
      const cached = this.#tasks.get(taskId);
      const projected = this.lookups?.task?.(taskId);
      const previous =
        cached === undefined
          ? projected
          : projected === undefined
            ? cached
            : { ...cached, ...projected };
      const agentId = stringOf(info?.['agentId']) ?? previous?.agentId;
      const state = taskStateOf(info?.['status']) ?? previous?.state ?? 'running';
      const stopReason = stringOf(info?.['stopReason']);
      const task: TranscriptTask = {
        taskId,
        kind: taskKindOf(info?.['kind']),
        state,
        detached: booleanOf(info?.['detached']) ?? previous?.detached ?? true,
        lifetime: taskLifetimeOf(info?.['lifetime']) ?? previous?.lifetime,
        ownerAgentId: stringOf(info?.['ownerAgentId']) ?? previous?.ownerAgentId,
        ownerTurnId: numberOf(info?.['ownerTurnId']) ?? previous?.ownerTurnId,
        goalId: stringOf(info?.['goalId']) ?? previous?.goalId,
        name: stringOf(info?.['collaborationTaskName']) ?? previous?.name,
        subagentName: stringOf(info?.['profile']) ?? previous?.subagentName,
        description: stringOf(info?.['description']) ?? previous?.description,
        agentId,
        outputTail: stringOf(record['outputTail']) ?? previous?.outputTail ?? '',
        startedAt: previous?.startedAt ?? isoOf(numberOf(info?.['startedAt'])),
        endedAt: isoOf(numberOf(info?.['endedAt'])) ?? previous?.endedAt,
        resultSummary: previous?.resultSummary,
        usage: previous?.usage,
        error:
          state === 'failed' || state === 'timed_out' || state === 'lost'
            ? (stopReason ?? previous?.error)
            : undefined,
        stateReason: stopReason ?? previous?.stateReason,
      };
      this.#tasks.set(taskId, task);
      if (task.kind === 'subagent' && agentId !== undefined) {
        this.#subagentTaskIds.set(agentId, taskId);
      }
      const operations: TranscriptOperation[] = [];
      if (record.type === 'task.started') {
        operations.push({
          op: 'taskref.upsert',
          item: {
            kind: 'taskref',
            refId: `ref-${taskId}`,
            taskId,
            at: isoOf(record.time),
          },
          beforeTurn: this.taskRefBeforeTurn(),
        });
      }
      if (task.kind !== 'subagent' || task.state !== 'running') {
        operations.push({ op: 'task.upsert', task });
      }
      return operations;
    }
    if (record.type === 'task.notified') {
      const turnId = this.#currentTurnId;
      const turn =
        turnId === undefined ? undefined : this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
      const sourceId = stringOf(record['sourceId']);
      const title = stringOf(record['title']);
      const body = stringOf(record['body']);
      if (
        turnId === undefined ||
        turn === undefined ||
        turn.state !== 'running' ||
        sourceId === undefined ||
        title === undefined ||
        body === undefined ||
        (turn.origin.kind === 'task' && turn.origin.taskId === sourceId)
      ) {
        return [];
      }
      const notificationId = taskNotificationIdOfRecord(record);
      if (notificationId !== undefined && this.#deliveredTaskNotifications.has(notificationId)) return [];
      if (notificationId !== undefined) this.#projectedTaskNotificationIds.add(notificationId);
      const stepRef = this.#steps.get(turnId);
      const step = stepRef === undefined ? undefined : this.#stepHeaders.get(stepRef.stepId);
      if (step?.state === 'running') {
        return [this.taskNotificationOp(record, turnId, step.stepId)];
      }
      const pending = this.#pendingTaskNotifications.get(turnId);
      if (pending === undefined) this.#pendingTaskNotifications.set(turnId, [record]);
      else pending.push(record);
      return [];
    }
    if (record.type === 'subagent.spawned') {
      const subagentId = stringOf(record['subagentId']);
      const parentToolCallId = stringOf(record['parentToolCallId']);
      const detached = booleanOf(record['runInBackground']);
      if (subagentId === undefined || parentToolCallId === undefined || detached === undefined) return [];
      const explicitTaskId = stringOf(record['taskId']);
      const taskId = explicitTaskId ?? subagentId;
      if (explicitTaskId === undefined) this.#subagentTaskIds.delete(subagentId);
      else this.#subagentTaskIds.set(subagentId, explicitTaskId);
      const startedAt = isoOf(record.time);
      const previous = this.#tasks.get(taskId);
      const sameRun =
        previous?.taskId === taskId &&
        previous.kind === 'subagent' &&
        previous.agentId === subagentId &&
        previous.startedAt === startedAt;
      const operations: TranscriptOperation[] = [];
      if (sameRun) {
        this.#replayedSubagentSpawns.set(subagentId, taskId);
        operations.push({ op: 'task.upsert', task: previous });
      } else {
        this.#replayedSubagentSpawns.delete(subagentId);
        const task: TranscriptTask = {
          taskId,
          kind: 'subagent',
          state: 'running',
          detached,
          name: stringOf(record['name']),
          subagentName: stringOf(record['subagentName']),
          description: stringOf(record['description']) ?? previous?.description,
          agentId: subagentId,
          outputTail: previous?.outputTail ?? '',
          startedAt,
        };
        this.#tasks.set(taskId, task);
        operations.push({ op: 'task.upsert', task });
      }
      const hit = this.#tools.get(parentToolCallId) ?? this.lookups?.tool?.(parentToolCallId);
      if (hit !== undefined && !hit.frame.agentRefs?.some((ref) => ref.agentId === subagentId)) {
        const frame: ToolCallFrame = {
          ...hit.frame,
          agentRefs: [
            ...(hit.frame.agentRefs ?? []),
            {
              agentId: subagentId,
              role: numberOf(record['swarmIndex']) === undefined ? 'child' : 'member',
            },
          ],
        };
        this.storeTool(parentToolCallId, { ...hit, frame });
        operations.push({ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame });
      }
      return operations;
    }
    if (
      record.type === 'subagent.started' ||
      record.type === 'subagent.completed' ||
      record.type === 'subagent.failed' ||
      record.type === 'subagent.suspended'
    ) {
      const subagentId = stringOf(record['subagentId']);
      if (subagentId === undefined) return [];
      const taskId =
        stringOf(record['taskId']) ?? this.#subagentTaskIds.get(subagentId) ?? subagentId;
      if (
        record.type === 'subagent.started' &&
        this.#replayedSubagentSpawns.get(subagentId) === taskId
      ) {
        return [];
      }
      this.#replayedSubagentSpawns.delete(subagentId);
      const previous = this.#tasks.get(taskId);
      if (record.type === 'subagent.started') {
        const at = isoOf(record.time);
        const task: TranscriptTask = {
          taskId,
          kind: 'subagent',
          state: 'running',
          detached: previous?.detached ?? true,
          name: previous?.name,
          subagentName: previous?.subagentName,
          description: previous?.description,
          agentId: subagentId,
          outputTail: previous?.outputTail ?? '',
          startedAt:
            previous?.kind === 'subagent' &&
            previous.agentId === subagentId &&
            previous.state === 'running'
              ? (previous.startedAt ?? at)
              : at,
        };
        this.#tasks.set(taskId, task);
        return [{ op: 'task.upsert', task }];
      }
      const terminal = record.type === 'subagent.completed' || record.type === 'subagent.failed';
      const error = stringOf(record['error']);
      const state =
        record.type === 'subagent.completed'
          ? 'completed'
          : record.type === 'subagent.failed'
            ? error === 'terminated'
              ? 'killed'
              : 'failed'
            : 'running';
      const task: TranscriptTask = {
        taskId,
        kind: 'subagent',
        state,
        detached: previous?.detached ?? true,
        name: previous?.name,
        subagentName: previous?.subagentName,
        description: previous?.description,
        agentId: subagentId,
        outputTail: previous?.outputTail ?? '',
        startedAt: previous?.startedAt ?? isoOf(record.time),
        endedAt: terminal ? isoOf(record.time) : previous?.endedAt,
        resultSummary: stringOf(record['resultSummary']) ?? previous?.resultSummary,
        usage: usageOf(record['usage']) ?? previous?.usage,
        error: state === 'failed' ? (error ?? previous?.error) : undefined,
        stateReason: stringOf(record['reason']) ?? error ?? previous?.stateReason,
      };
      this.#tasks.set(taskId, task);
      return [{ op: 'task.upsert', task }];
    }
    if (record.type === 'interaction.request') {
      const interactionId = stringOf(record['id']);
      const interactionKind = stringOf(record['kind']);
      if (
        interactionId === undefined ||
        (interactionKind !== 'approval' && interactionKind !== 'question')
      ) {
        return [];
      }
      const request = projectWireQuestionRequest(interactionId, interactionKind, record['request']);
      const requestToolCallId = stringOf(objectOf(request)?.['toolCallId']);
      const toolCallId = stringOf(record['toolCallId']) ?? requestToolCallId;
      const recordOrigin = objectOf(record['origin']);
      const originAgentId = stringOf(record['agentId']);
      const originTurnId = numberOf(record['turnId']);
      const origin =
        recordOrigin ??
        (originAgentId === undefined && originTurnId === undefined
          ? undefined
          : { agentId: originAgentId, turnId: originTurnId });
      const interaction: TranscriptInteraction = {
        interactionId,
        interactionKind,
        toolCallId,
        origin,
        anchor: toolCallId === undefined ? undefined : { kind: 'tool_call', toolCallId },
        state: 'pending',
        request,
      };
      this.#interactions.set(interactionId, interaction);
      return [{ op: 'interaction.upsert', interaction }];
    }
    if (record.type === 'interaction.resolved') {
      const interactionId = stringOf(record['id']);
      const previous = interactionId === undefined ? undefined : this.#interactions.get(interactionId);
      if (interactionId === undefined || previous === undefined) return [];
      const interaction: TranscriptInteraction = {
        ...previous,
        state: projectInteractionEndState(previous.interactionKind, record['response']),
        response: record['response'],
      };
      this.#interactions.set(interactionId, interaction);
      return [{ op: 'interaction.upsert', interaction }];
    }
    if (record.type === 'turn.step.interrupted') {
      const turnId = turnIdOf(record['turnId'], this.#currentTurnId);
      const stepOrdinal = numberOf(record['step']);
      const reason = stringOf(record['reason']);
      if (turnId === undefined || stepOrdinal === undefined || reason === undefined) return [];
      const recordStepId = stringOf(record['stepId']);
      const existing =
        (recordStepId === undefined ? undefined : this.#stepHeaders.get(recordStepId)) ??
        this.stepForOrdinal(turnId, stepOrdinal);
      const stepId = recordStepId ?? existing?.stepId ?? `${turnId}.${stepOrdinal}`;
      const step: StepHeader = {
        kind: 'step',
        stepId,
        turnId,
        ordinal: stepOrdinal,
        state: 'interrupted',
        startedAt: existing?.startedAt,
        endedAt: isoOf(record.time),
        usage: existing?.usage,
        finishReason: existing?.finishReason,
        timing: existing?.timing,
        endReason: reason,
        endMessage: stringOf(record['message']),
      };
      this.storeStep(stepId, step);
      return [this.ensureTurn(turnId), { op: 'step.upsert', turnId, step }];
    }
    if (record.type === 'turn.step.retrying') return [];
    if (
      record.type === 'turn.cancel' &&
      record['target'] === 'active' &&
      record['reason'] === 'user_cancelled'
    ) {
      return [this.marker(record, ordinal, 'interruption')];
    }
    return [];
  }

  private taskNotificationOp(
    record: TranscriptWireRecord,
    turnId: string,
    stepId: string,
  ): TranscriptOperation {
    const sourceId = stringOf(record['sourceId'])!;
    return {
      op: 'frame.upsert',
      turnId,
      stepId,
      frame: {
        kind: 'text',
        frameId: taskNotificationFrameId(sourceId),
        role: 'user',
        text: `${stringOf(record['title'])!}\n${stringOf(record['body'])!}`.trim(),
        taskId: sourceId,
        origin: { kind: 'task', taskId: sourceId },
      },
    };
  }

  private takePendingTaskNotifications(turnId: string, stepId: string): TranscriptOperation[] {
    const pending = this.#pendingTaskNotifications.get(turnId);
    if (pending === undefined) return [];
    this.#pendingTaskNotifications.delete(turnId);
    return pending.map((record) => this.taskNotificationOp(record, turnId, stepId));
  }

  private marker(
    record: TranscriptWireRecord,
    ordinal: number,
    marker: string,
  ): TranscriptOperation {
    return {
      op: 'marker.upsert',
      item: {
        kind: 'marker',
        markerId: `wire:v2:${record.type}:${factId(record, ordinal)}`,
        marker,
        payload: record,
        at: isoOf(record.time),
      },
    };
  }

  private turnPrompt(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    const rawTurnId = numberOf(record['turnId']);
    const turnOrdinal = rawTurnId ?? this.#legacyTurnOrdinal++;
    this.#legacyTurnOrdinal = Math.max(this.#legacyTurnOrdinal, turnOrdinal + 1);
    const turnId = `t${turnOrdinal}`;
    this.#canonicalTurns.add(turnId);
    this.trackTurn(turnId);
    const promptId = stringOf(record['promptId']) ?? stringOf(record['messageId']);
    const alreadyDelivered = promptId !== undefined && this.#deliveries.has(promptId);
    if (alreadyDelivered && this.#turnHeaders.get(turnId)?.message?.messageId === promptId) return [];
    const headerOnly = record['managed'] === true || alreadyDelivered;
    if (isUndoAnchorOrigin(record['origin']) && !headerOnly) this.#undoAnchors.add(turnId);
    const input = headerOnly ? [] : arrayOf(record['input']);
    const activations = headerOnly ? [] : bundledSkillActivations(record['origin']);
    const openingInput = input.slice(activations.length);
    const prompt = openingInput.map(textOfPart).join('');
    this.#currentTurnId = turnId;
    this.#currentPromptId = promptId;
    const attachmentIds: string[] = [];
    const operations: TranscriptOperation[] = activations.map((activation, index) => ({
      op: 'marker.upsert',
      item: {
        kind: 'marker',
        markerId: `wire:v2:skill:${activation.activationId}`,
        marker: 'skill',
        payload: {
          text: textOfPart(input[index]),
          origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation },
        },
        at: isoOf(record.time),
      },
      beforeTurn: turnOrdinal,
    }));
    if (activations.length > 0) {
      this.#turnOwnedItemIds.set(
        turnId,
        activations.map((activation) => `wire:v2:skill:${activation.activationId}`),
      );
    }
    for (const value of openingInput) {
      const media = mediaOf(objectOf(value));
      if (media === undefined) continue;
      const attachmentId = `${turnId}.att${attachmentIds.length + 1}`;
      attachmentIds.push(attachmentId);
      operations.push({
        op: 'attachment.upsert',
        attachment: {
          attachmentId,
          mediaType: `${media.kind}/*`,
          name: media.name,
          source: media.source,
          owner: { kind: 'turn', turnId },
        },
      });
    }
    const turn: TurnHeader = {
      kind: 'turn',
      turnId,
      ordinal: turnOrdinal,
      state: 'running',
      origin: mapOrigin(record['origin']),
      promptId: stringOf(record['promptId']),
      message: {
        messageId: promptId ?? `legacy:v1:r${ordinal}:message`,
        role: 'user',
        revision: numberOf(record['revision']) ?? 0,
        provenance: {
          source: promptId === undefined ? 'legacy-wire' : 'engine',
          recordOrdinal: promptId === undefined ? ordinal : undefined,
        },
        lineage: lineageOf(record['lineage']),
      },
      prompt: record['managed'] === true || alreadyDelivered ? undefined : prompt.length > 0 ? prompt : undefined,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      startedAt: isoOf(record.time),
    };
    this.#turnHeaders.set(turnId, turn);
    operations.push({ op: 'turn.upsert', turn });
    return operations;
  }

  private turnSteer(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    if (record['managed'] === true) return [];
    const turnId = turnIdOf(record['turnId'], this.#currentTurnId);
    if (turnId === undefined) return [];
    const input = arrayOf(record['input']);
    const text = input.map(textOfPart).join('');
    const media = mediaPartsOf(input);
    if (text.length === 0 && media.length === 0) return [];
    const explicitPromptId = stringOf(record['promptId']);
    const promptId = explicitPromptId ?? `legacy:v1:r${ordinal}:steer`;
    const pending = this.#pendingSteers.get(turnId);
    const steer: PendingSteer = {
      promptId,
      explicitPromptId,
      text,
      media,
      revision: numberOf(record['revision']) ?? 0,
      provenance: {
        source: explicitPromptId === undefined ? 'legacy-wire' : 'engine',
        recordOrdinal: explicitPromptId === undefined ? ordinal : undefined,
      },
      origin: record['origin'],
    };
    if (pending === undefined) this.#pendingSteers.set(turnId, [steer]);
    else pending.push(steer);
    if (explicitPromptId === undefined) {
      let credits = this.#unpairedSteerCredits.get(turnId);
      if (credits === undefined) {
        credits = new Map();
        this.#unpairedSteerCredits.set(turnId, credits);
      }
      const originKind = legacyOriginKind(record['origin']);
      credits.set(originKind, (credits.get(originKind) ?? 0) + 1);
    }
    return [];
  }

  private takePendingSteers(turnId: string, stepId: string): TranscriptOperation[] {
    const pending = this.#pendingSteers.get(turnId);
    if (pending === undefined || pending.length === 0) return [];
    this.#pendingSteers.delete(turnId);
    const operations: TranscriptOperation[] = [];
    for (const steer of pending) {
      if (steer.explicitPromptId !== undefined) this.#steeredMessageIds.add(steer.explicitPromptId);
      const attachmentIds: string[] = [];
      for (const media of steer.media) {
        const attachmentId = `${steer.promptId}.att${attachmentIds.length + 1}`;
        attachmentIds.push(attachmentId);
        operations.push({
          op: 'attachment.upsert',
          attachment: {
            attachmentId,
            mediaType: `${media.kind}/*`,
            name: media.name,
            source: media.source,
            owner: { kind: 'frame', turnId, stepId, frameId: steer.promptId },
          },
        });
      }
      operations.push({
        op: 'frame.upsert',
        turnId,
        stepId,
        frame: {
          kind: 'text',
          frameId: steer.promptId,
          part: {
            partId: steer.promptId,
            messageId: steer.promptId,
            revision: steer.revision,
            provenance: steer.provenance,
          },
          role: 'user',
          text: steer.text,
          origin: projectTranscriptUserOrigin(steer.origin) ?? steer.origin,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        },
      });
    }
    return operations;
  }

  private consumeSteeredUserMessage(
    messageId: string,
    origin: Readonly<Record<string, unknown>> | undefined,
  ): boolean {
    if (this.#steeredMessageIds.has(messageId)) return true;
    const turnId = this.#currentTurnId;
    const pending = turnId === undefined ? undefined : this.#pendingSteers.get(turnId);
    if (pending?.some((steer) => steer.explicitPromptId === messageId)) {
      this.#steeredMessageIds.add(messageId);
      return true;
    }
    if (turnId === undefined || !isVisibleLegacyTurnOrigin(this.agentId, origin)) return false;
    const credits = this.#unpairedSteerCredits.get(turnId);
    const originKind = legacyOriginKind(origin);
    const count = credits?.get(originKind) ?? 0;
    if (count === 0) return false;
    credits!.set(originKind, count - 1);
    this.#steeredMessageIds.add(messageId);
    return true;
  }

  private legacyMessage(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    const message = objectOf(record['message']);
    const role = stringOf(message?.['role']);
    if (message === undefined || role === undefined || role === 'system') return [];
    const messageId = stringOf(message['id']) ?? `legacy:v1:r${ordinal}:message`;
    const content = arrayOf(message['content']);
    if (role === 'user') {
      const notificationId = taskNotificationIdOfMessage(message);
      if (notificationId !== undefined && this.#projectedTaskNotificationIds.has(notificationId)) return [];
      if (notificationId !== undefined) this.#deliveredTaskNotifications.set(notificationId, messageId);
      const canonicalDelivery = objectOf(record['delivery']);
      if (canonicalDelivery !== undefined) return this.deliveredMessage(record, message, ordinal, canonicalDelivery);
      if (messageId === this.#currentPromptId || this.#deliveries.has(messageId)) return [];
      const origin = objectOf(message['origin']);
      if (this.consumeSteeredUserMessage(messageId, origin)) return [];
      if (
        origin?.['kind'] === 'agent_message' ||
        origin?.['kind'] === 'injection' ||
        (this.#canonicalTurns.size > 0 && isVisibleLegacyTurnOrigin(this.agentId, origin))
      ) return this.deliveredMessage(record, message, ordinal);
      const turnOrdinal = this.#legacyTurnOrdinal++;
      if (!isVisibleLegacyTurnOrigin(this.agentId, origin)) return [];
      const turnId = `t${turnOrdinal}`;
      this.#currentTurnId = turnId;
      this.#currentPromptId = messageId;
      this.trackTurn(turnId);
      if (isUndoAnchorOrigin(message['origin'])) this.#undoAnchors.add(turnId);
      const activations = bundledSkillActivations(message['origin']);
      const openingContent = content.slice(activations.length);
      const attachmentIds: string[] = [];
      const operations: TranscriptOperation[] = activations.map((activation, index) => ({
        op: 'marker.upsert',
        item: {
          kind: 'marker',
          markerId: `wire:v2:skill:${activation.activationId}`,
          marker: 'skill',
          payload: {
            text: textOfPart(content[index]),
            origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation },
          },
          at: isoOf(record.time),
        },
        beforeTurn: turnOrdinal,
      }));
      if (activations.length > 0) {
        this.#turnOwnedItemIds.set(
          turnId,
          activations.map((activation) => `wire:v2:skill:${activation.activationId}`),
        );
      }
      for (const value of openingContent) {
        const media = mediaOf(objectOf(value));
        if (media === undefined) continue;
        const attachmentId = `${turnId}.att${attachmentIds.length + 1}`;
        attachmentIds.push(attachmentId);
        operations.push({
          op: 'attachment.upsert',
          attachment: {
            attachmentId,
            mediaType: `${media.kind}/*`,
            name: media.name,
            source: media.source,
            owner: { kind: 'turn', turnId },
          },
        });
      }
      const prompt = openingContent.map(textOfPart).join('');
      const turn: TurnHeader = {
        kind: 'turn',
        turnId,
        ordinal: turnOrdinal,
        state: 'running',
        origin: mapOrigin(message['origin']),
        message: {
          messageId,
          role: 'user',
          revision: 0,
          provenance: { source: 'legacy-wire', recordOrdinal: ordinal },
        },
        prompt: prompt.length > 0 ? prompt : undefined,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        startedAt: isoOf(record.time),
      };
      this.#turnHeaders.set(turnId, turn);
      operations.push({ op: 'turn.upsert', turn });
      return operations;
    }
    if (role === 'assistant') return this.legacyAssistant(message, ordinal, record.time);
    if (role === 'tool') {
      const toolCallId = stringOf(message['toolCallId']);
      if (toolCallId === undefined) return [];
      return this.toolResult(
        {
          toolCallId,
          result: {
            output: content.map(textOfPart).join(''),
            isError: message['isError'] === true,
          },
        },
        record.time,
      );
    }
    return [];
  }

  private deliveredMessage(
    record: TranscriptWireRecord,
    message: Readonly<Record<string, unknown>>,
    ordinal: number,
    canonical?: Readonly<Record<string, unknown>>,
  ): TranscriptOperation[] {
    const messageId = stringOf(canonical?.['messageId']) ?? stringOf(message['id']) ?? `legacy:v1:r${ordinal}:message`;
    if (this.#deliveries.has(messageId)) return [];
    const origin = objectOf(message['origin']);
    const current = this.#currentTurnId === undefined ? undefined : this.#turnHeaders.get(this.#currentTurnId);
    const inferredTurn = current?.state === 'running' ? current.turnId : undefined;
    const turnId = canonical === undefined
      ? inferredTurn
      : turnIdOf(canonical['turnId'], undefined) ?? inferredTurn;
    const priorStep = turnId === undefined ? undefined : this.#steps.get(turnId);
    const inferredStep = canonical === undefined || canonical['turnId'] === undefined;
    const acceptedStepId = inferredStep ? priorStep?.stepId : stringOf(canonical?.['stepId']);
    const acceptedStep = inferredStep ? priorStep?.ordinal : numberOf(canonical?.['step']);
    const stepId = turnId === undefined ? undefined : acceptedStepId ?? priorStep?.stepId ?? `${turnId}.delivery`;
    const stepOrdinal = acceptedStep ?? priorStep?.ordinal ?? 0;
    const delivery: MessageDelivery = {
      deliveryId: stringOf(canonical?.['deliveryId']) ?? `legacy:delivery:${messageId}`,
      messageId,
      turnId,
      stepId: acceptedStepId,
      step: acceptedStep,
      deliveredAt: stringOf(canonical?.['deliveredAt']) ?? isoOf(record.time),
      origin: deliveryOrigin(canonical?.['origin'], origin?.['kind']),
    };
    this.#deliveries.set(messageId, delivery);
    const turn = turnId === undefined ? undefined : this.#turnHeaders.get(turnId);
    this.#deliveryUndoRecords.set(messageId, {
      ordinal,
      anchor: isUndoAnchorOrigin(message['origin']) && turn?.message?.messageId !== messageId,
    });
    if (turn?.message?.messageId === messageId) {
      if (isUndoAnchorOrigin(message['origin'])) this.#undoAnchors.add(turn.turnId);
      if (turn.prompt !== undefined) return [];
    }
    const input = arrayOf(message['content']);
    const activations = bundledSkillActivations(message['origin']);
    const content = input.slice(activations.length);
    const text = content.map(textOfPart).join('');
    const operations: TranscriptOperation[] = [];
    if (turn?.message?.messageId === messageId && activations.length > 0) {
      this.#turnOwnedItemIds.set(turn.turnId, activations.map((activation) => `wire:v2:skill:${activation.activationId}`));
      operations.push(...activations.map((activation, index): TranscriptOperation => ({
        op: 'marker.upsert',
        item: {
          kind: 'marker', markerId: `wire:v2:skill:${activation.activationId}`, marker: 'skill',
          payload: { text: textOfPart(input[index]), origin: { kind: 'skill_activation', trigger: 'user-slash', ...activation } },
          at: delivery.deliveredAt,
        },
        beforeTurn: turn.ordinal,
      })));
    }
    const attachmentIds: string[] = [];
    for (const media of mediaPartsOf(content)) {
      const attachmentId = `${messageId}.att${attachmentIds.length + 1}`;
      attachmentIds.push(attachmentId);
      operations.push({
        op: 'attachment.upsert',
        attachment: {
          attachmentId, mediaType: `${media.kind}/*`, name: media.name, source: media.source,
          owner: turn?.message?.messageId === messageId ? { kind: 'turn', turnId: turn.turnId }
            : turnId === undefined || stepId === undefined ? undefined : { kind: 'frame', turnId, stepId, frameId: messageId },
        },
      });
    }
    if (turn?.message?.messageId === messageId) {
      const deliveredTurn: TurnHeader = {
        ...turn, prompt: text.length === 0 ? undefined : text,
        attachmentIds: attachmentIds.length === 0 ? undefined : attachmentIds, delivery,
      };
      this.#turnHeaders.set(turn.turnId, deliveredTurn);
      operations.push({ op: 'turn.upsert', turn: deliveredTurn });
      return operations;
    }
    if (turnId === undefined || stepId === undefined) {
      operations.push({
        op: 'marker.upsert',
        item: {
          kind: 'marker', markerId: `message-delivery:${messageId}`, marker: 'message.delivery',
          at: delivery.deliveredAt,
          payload: { messageId, text, origin: message['origin'], delivery, attachmentIds },
        },
      });
      return operations;
    }
    if (turn === undefined) operations.push(this.ensureTurn(turnId));
    if (!this.#stepHeaders.has(stepId)) {
      const step: StepHeader = {
        kind: 'step', turnId, stepId, ordinal: stepOrdinal,
        state: canonical?.['stepId'] === undefined ? 'completed' : 'running',
        startedAt: delivery.deliveredAt,
      };
      this.storeStep(stepId, step);
      operations.push({ op: 'step.upsert', turnId, step });
    }
    operations.push({
      op: 'frame.upsert', turnId, stepId,
      frame: {
        kind: 'text', frameId: messageId,
        part: {
          partId: messageId, messageId, revision: numberOf(message['revision']) ?? 0,
          provenance: { source: canonical === undefined ? 'legacy-wire' : 'engine', recordOrdinal: canonical === undefined ? ordinal : undefined },
        },
        role: 'user', text,
        origin: projectTranscriptUserOrigin(message['origin']) ?? message['origin'],
        delivery, attachmentIds: attachmentIds.length === 0 ? undefined : attachmentIds,
      },
    });
    return operations;
  }

  private legacyAssistant(
    message: Readonly<Record<string, unknown>>,
    ordinal: number,
    time: number | undefined,
  ): TranscriptOperation[] {
    const turnId = this.#currentTurnId;
    if (turnId === undefined) return [];
    let step = this.#steps.get(turnId);
    if (step === undefined) {
      step = { stepId: `legacy:v1:r${ordinal}:step`, ordinal: 1 };
      this.#steps.set(turnId, step);
    }
    const previousStep = this.#stepHeaders.get(step.stepId);
    const stepHeader: StepHeader = {
      kind: 'step',
      stepId: step.stepId,
      turnId,
      ordinal: step.ordinal,
      state: 'completed',
      startedAt: previousStep?.startedAt,
      endedAt: isoOf(time),
    };
    this.storeStep(step.stepId, stepHeader);
    const operations: TranscriptOperation[] = [{ op: 'step.upsert', turnId, step: stepHeader }];
    const messageId = stringOf(message['id']) ?? step.stepId;
    const content = arrayOf(message['content']);
    for (let partOrdinal = 0; partOrdinal < content.length; partOrdinal += 1) {
      const part = objectOf(content[partOrdinal]);
      const type = stringOf(part?.['type']);
      const partId = `legacy:v1:r${ordinal}:part${partOrdinal}`;
      if (type === 'text') {
        operations.push({
          op: 'frame.upsert',
          turnId,
          stepId: step.stepId,
          frame: {
            kind: 'text',
            frameId: partId,
            part: {
              partId,
              messageId,
              revision: 0,
              provenance: { source: 'legacy-wire', recordOrdinal: ordinal, partOrdinal },
            },
            role: 'assistant',
            text: stringOf(part?.['text']) ?? '',
          },
        });
      } else if (type === 'think') {
        operations.push({
          op: 'frame.upsert',
          turnId,
          stepId: step.stepId,
          frame: {
            kind: 'thinking',
            frameId: partId,
            part: {
              partId,
              messageId,
              revision: 0,
              provenance: { source: 'legacy-wire', recordOrdinal: ordinal, partOrdinal },
            },
            text: stringOf(part?.['think']) ?? '',
          },
        });
      }
    }
    for (const callValue of arrayOf(message['toolCalls'])) {
      const call = objectOf(callValue);
      const toolCallId = stringOf(call?.['id']);
      if (toolCallId === undefined) continue;
      const frame: ToolCallFrame = {
        kind: 'tool',
        frameId: `${step.stepId}.${toolCallId}`,
        part: {
          partId: toolCallId,
          messageId,
          revision: 0,
          provenance: { source: 'legacy-wire', recordOrdinal: ordinal },
        },
        toolCallId,
        name: stringOf(call?.['name']) ?? '',
        state: 'running',
        input: parseJson(stringOf(call?.['arguments'])),
        startedAt: isoOf(time),
      };
      this.storeTool(toolCallId, { turnId, stepId: step.stepId, frame });
      operations.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    }
    const previous = this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
    if (previous !== undefined) {
      const turn: TurnHeader = { ...previous, state: 'completed', endedAt: isoOf(time) };
      this.#turnHeaders.set(turnId, turn);
      operations.push({ op: 'turn.upsert', turn });
    }
    return operations;
  }

  private loopEvent(
    event: Readonly<Record<string, unknown>>,
    ordinal: number,
    time: number | undefined,
  ): TranscriptOperation[] {
    const type = stringOf(event['type']);
    if (type === 'step.begin') {
      const turnId = turnIdOf(event['turnId'], this.#turns.at(-1));
      if (turnId === undefined) return [];
      const stepId = stringOf(event['uuid']) ?? `legacy:v1:r${ordinal}:step`;
      const stepOrdinal = numberOf(event['step']) ?? 1;
      const step: StepHeader = {
        kind: 'step',
        stepId,
        turnId,
        ordinal: stepOrdinal,
        state: 'running',
        startedAt: isoOf(time),
      };
      this.#steps.set(turnId, { stepId, ordinal: stepOrdinal });
      this.storeStep(stepId, step);
      return [
        this.ensureTurn(turnId),
        { op: 'step.upsert', turnId, step },
        ...this.takePendingSteers(turnId, stepId),
        ...this.takePendingTaskNotifications(turnId, stepId),
      ];
    }
    if (type === 'step.end') return this.stepEnd(event, time);
    if (type === 'content.part') return this.contentPart(event, ordinal);
    if (type === 'tool.call') return this.toolCall(event, ordinal, time);
    if (type === 'tool.result') return this.toolResult(event, time);
    return [];
  }

  private stepEnd(
    event: Readonly<Record<string, unknown>>,
    time: number | undefined,
  ): TranscriptOperation[] {
    const stepId = stringOf(event['uuid']);
    const turnId = turnIdOf(event['turnId'], undefined) ?? this.turnForStep(stepId);
    if (turnId === undefined || stepId === undefined) return [];
    const ordinal = numberOf(event['step']) ?? this.#steps.get(turnId)?.ordinal ?? 1;
    const usage = usageOf(event['usage']);
    if (usage !== undefined) {
      const usages = this.#stepUsages.get(turnId) ?? [];
      usages.push(usage);
      this.#stepUsages.set(turnId, usages);
    }
    const previousStep = this.#stepHeaders.get(stepId);
    const finishReason =
      stringOf(event['finishReason']) ??
      stringOf(event['rawFinishReason']) ??
      stringOf(event['providerFinishReason']);
    const interrupted = finishReason === 'interrupted' || finishReason === 'error';
    const step: StepHeader = {
      kind: 'step',
      stepId,
      turnId,
      ordinal,
      state: interrupted ? 'interrupted' : 'completed',
      startedAt: previousStep?.startedAt,
      endedAt: isoOf(time),
      usage,
      finishReason,
      endReason: interrupted ? finishReason : undefined,
      timing: {
        llmFirstTokenLatencyMs: numberOf(event['llmFirstTokenLatencyMs']),
        llmStreamDurationMs: numberOf(event['llmStreamDurationMs']),
        llmRequestBuildMs: numberOf(event['llmRequestBuildMs']),
        llmServerFirstTokenMs: numberOf(event['llmServerFirstTokenMs']),
        llmServerDecodeMs: numberOf(event['llmServerDecodeMs']),
        llmClientConsumeMs: numberOf(event['llmClientConsumeMs']),
      },
    };
    this.storeStep(stepId, step);
    const operations: TranscriptOperation[] = [{ op: 'step.upsert', turnId, step }];
    if (!this.#canonicalTurns.has(turnId)) {
      const previous = this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
      if (previous !== undefined) {
        const state =
          finishReason === 'error'
            ? 'failed'
            : finishReason === 'interrupted'
              ? 'cancelled'
              : 'completed';
        const turn: TurnHeader = { ...previous, state, endedAt: isoOf(time) };
        this.#turnHeaders.set(turnId, turn);
        operations.push({ op: 'turn.upsert', turn });
      }
    }
    return operations;
  }

  private contentPart(
    event: Readonly<Record<string, unknown>>,
    ordinal: number,
  ): TranscriptOperation[] {
    const stepId = stringOf(event['stepUuid']);
    const turnId = turnIdOf(event['turnId'], undefined) ?? this.turnForStep(stepId);
    const part = objectOf(event['part']);
    if (stepId === undefined || turnId === undefined || part === undefined) return [];
    const type = stringOf(part['type']);
    const partId = stringOf(event['uuid']) ?? `legacy:v1:r${ordinal}:part0`;
    const identity = {
      partId,
      messageId: stepId,
      revision: numberOf(event['revision']) ?? 0,
      provenance: {
        source: stringOf(event['uuid']) === undefined ? 'legacy-wire' as const : 'engine' as const,
        recordOrdinal: stringOf(event['uuid']) === undefined ? ordinal : undefined,
        partOrdinal: stringOf(event['uuid']) === undefined ? 0 : undefined,
      },
    };
    if (type === 'text') {
      return [
        {
          op: 'frame.upsert',
          turnId,
          stepId,
          frame: {
            kind: 'text',
            frameId: partId,
            part: identity,
            role: 'assistant',
            text: stringOf(part['text']) ?? '',
          },
        },
      ];
    }
    if (type === 'think') {
      return [
        {
          op: 'frame.upsert',
          turnId,
          stepId,
          frame: {
            kind: 'thinking',
            frameId: partId,
            part: identity,
            text: stringOf(part['think']) ?? '',
          },
        },
      ];
    }
    return [];
  }

  private toolCall(
    event: Readonly<Record<string, unknown>>,
    ordinal: number,
    time: number | undefined,
  ): TranscriptOperation[] {
    const toolCallId = stringOf(event['toolCallId']);
    const stepId = stringOf(event['stepUuid']);
    const turnId = turnIdOf(event['turnId'], undefined) ?? this.turnForStep(stepId);
    if (toolCallId === undefined || stepId === undefined || turnId === undefined) return [];
    const frame: ToolCallFrame = {
      kind: 'tool',
      frameId: `${stepId}.${toolCallId}`,
      part: {
        partId: stringOf(event['uuid']) ?? toolCallId,
        messageId: stepId,
        revision: numberOf(event['revision']) ?? 0,
        provenance: {
          source: stringOf(event['uuid']) === undefined ? 'legacy-wire' : 'engine',
          recordOrdinal: stringOf(event['uuid']) === undefined ? ordinal : undefined,
        },
      },
      toolCallId,
      name: stringOf(event['name']) ?? '',
      state: 'running',
      input: event['args'],
      startedAt: isoOf(time),
    };
    const hit = { turnId, stepId, frame };
    this.storeTool(toolCallId, hit);
    return [{ op: 'frame.upsert', ...hit }];
  }

  private toolResult(
    event: Readonly<Record<string, unknown>>,
    time: number | undefined,
  ): TranscriptOperation[] {
    const toolCallId = stringOf(event['toolCallId']);
    if (toolCallId === undefined) return [];
    const cached = this.#tools.get(toolCallId);
    const projected = this.lookups?.tool?.(toolCallId);
    const hit = cached ?? projected;
    if (hit === undefined) return [];
    const result = objectOf(event['result']);
    const output = result?.['output'];
    const isError = result?.['isError'] === true;
    const frame: ToolCallFrame = {
      ...hit.frame,
      ...projected?.frame,
      state: isError ? 'error' : 'done',
      output,
      error: isError && typeof output === 'string' ? output : undefined,
      endedAt: isoOf(time),
    };
    this.storeTool(toolCallId, { ...hit, frame });
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private turnEnded(record: TranscriptWireRecord): TranscriptOperation[] {
    const n = numberOf(record['turnId']);
    if (n === undefined) return [];
    const turnId = `t${n}`;
    this.#pendingTaskNotifications.delete(turnId);
    const previous = this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
    if (previous === undefined && !this.#turnIds.has(turnId)) return [];
    const endedAt = isoOf(record.time);
    const operations: TranscriptOperation[] = [];
    const runningToolIds = this.#runningToolIdsByTurn.get(turnId);
    for (const toolCallId of this.#toolIdsByTurn.get(turnId) ?? []) {
      if (!runningToolIds?.has(toolCallId)) continue;
      const hit = this.#tools.get(toolCallId);
      if (hit === undefined) continue;
      const frame: ToolCallFrame = { ...hit.frame, state: 'interrupted', endedAt };
      this.storeTool(toolCallId, { ...hit, frame });
      operations.push({ op: 'frame.upsert', turnId, stepId: hit.stepId, frame });
    }
    const runningStepIds = this.#runningStepIdsByTurn.get(turnId);
    for (const stepId of this.#stepIdsByTurn.get(turnId) ?? []) {
      if (!runningStepIds?.has(stepId)) continue;
      const previousStep = this.#stepHeaders.get(stepId);
      if (previousStep === undefined) continue;
      const step: StepHeader = { ...previousStep, state: 'interrupted', endedAt };
      this.storeStep(stepId, step);
      operations.push({ op: 'step.upsert', turnId, step });
    }
    const stepUsages = this.#stepUsages.get(turnId);
    this.#stepUsages.delete(turnId);
    const usage =
      stepUsages === undefined || stepUsages.length === 0
        ? previous?.usage
        : {
            inputTokens: stepUsages.reduce(
              (sum, current) => sum + current.inputOther + current.inputCacheCreation,
              0,
            ),
            outputTokens: stepUsages.reduce((sum, current) => sum + current.output, 0),
            cachedTokens: stepUsages.reduce((sum, current) => sum + current.inputCacheRead, 0),
          };
    const rawReason = record['reason'];
    const reason: 'completed' | 'cancelled' | 'failed' | 'blocked' =
      rawReason === 'cancelled' || rawReason === 'failed' || rawReason === 'blocked'
        ? rawReason
        : 'completed';
    const durationMs = numberOf(record['durationMs']);
    const turn: TurnHeader = {
      kind: 'turn',
      turnId,
      ordinal: n,
      state: turnState(reason),
      origin: previous?.origin ?? { kind: 'other' },
      promptId: previous?.promptId,
      message: previous?.message,
      delivery: previous?.delivery,
      prompt: previous?.prompt,
      attachmentIds: previous?.attachmentIds,
      startedAt: previous?.startedAt,
      endedAt,
      usage,
      execution: this.#executions.get(turnId) ?? previous?.execution,
      durationMs,
      error: stringOf(objectOf(record['error'])?.['message']),
    };
    this.#turnHeaders.set(turnId, turn);
    operations.push(
      { op: 'turn.upsert', turn },
      {
        op: 'meta.merge',
        meta: {
          activity: 'idle',
          agent: {
            phase: {
              kind: 'ended',
              turnId: n,
              reason,
              durationMs,
              at: numberOf(record.time) ?? 0,
            },
          },
        },
      },
    );
    if (record['reason'] === 'cancelled' && record['interruptReason'] === 'user_cancelled') {
      operations.push({
        op: 'marker.upsert',
        item: {
          kind: 'marker',
          markerId: `turn:${n}:interruption`,
          marker: 'interruption',
          payload: { turnId: n, reason: record['interruptReason'] },
          at: endedAt,
        },
      });
    }
    return operations;
  }

  private ensureTurn(turnId: string): TranscriptOperation {
    const n = Number(turnId.slice(1));
    this.trackTurn(turnId);
    const previous = this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
    const turn: TurnHeader =
      previous === undefined
        ? {
            kind: 'turn',
            turnId,
            ordinal: Number.isFinite(n) ? n : this.#turns.length - 1,
            state: 'running',
            origin: { kind: 'other' },
          }
        : { ...previous, state: 'running' };
    this.#turnHeaders.set(turnId, turn);
    return { op: 'turn.upsert', turn };
  }

  private taskRefBeforeTurn(): number | undefined {
    const turnId = this.#currentTurnId;
    if (turnId === undefined) return undefined;
    const turn = this.#turnHeaders.get(turnId) ?? this.lookups?.turn?.(turnId);
    return turn === undefined ? undefined : turn.ordinal + 1;
  }

  private turnForStep(stepId: string | undefined): string | undefined {
    return stepId === undefined ? undefined : this.#turnIdByStepId.get(stepId);
  }

  private stepForOrdinal(turnId: string, ordinal: number): StepHeader | undefined {
    for (const stepId of this.#stepIdsByTurn.get(turnId) ?? []) {
      const step = this.#stepHeaders.get(stepId);
      if (step?.ordinal === ordinal) return step;
    }
    return undefined;
  }

  private trackTurn(turnId: string): void {
    if (this.#turnIds.has(turnId)) return;
    this.#turnIds.add(turnId);
    this.#turns.push(turnId);
  }

  private storeStep(stepId: string, step: StepHeader): void {
    const previousTurnId = this.#turnIdByStepId.get(stepId);
    if (previousTurnId !== undefined && previousTurnId !== step.turnId) {
      this.#stepIdsByTurn.get(previousTurnId)?.delete(stepId);
      this.#runningStepIdsByTurn.get(previousTurnId)?.delete(stepId);
    }
    this.#turnIdByStepId.set(stepId, step.turnId);
    this.#stepHeaders.set(stepId, step);
    let stepIds = this.#stepIdsByTurn.get(step.turnId);
    if (stepIds === undefined) {
      stepIds = new Set();
      this.#stepIdsByTurn.set(step.turnId, stepIds);
    }
    stepIds.add(stepId);
    let running = this.#runningStepIdsByTurn.get(step.turnId);
    if (step.state === 'running') {
      if (running === undefined) {
        running = new Set();
        this.#runningStepIdsByTurn.set(step.turnId, running);
      }
      running.add(stepId);
    } else {
      running?.delete(stepId);
      if (running?.size === 0) this.#runningStepIdsByTurn.delete(step.turnId);
    }
  }

  private storeTool(
    toolCallId: string,
    hit: { turnId: string; stepId: string; frame: ToolCallFrame },
  ): void {
    const previousTurnId = this.#tools.get(toolCallId)?.turnId;
    if (previousTurnId !== undefined && previousTurnId !== hit.turnId) {
      this.#toolIdsByTurn.get(previousTurnId)?.delete(toolCallId);
      this.#runningToolIdsByTurn.get(previousTurnId)?.delete(toolCallId);
    }
    this.#tools.set(toolCallId, hit);
    let toolIds = this.#toolIdsByTurn.get(hit.turnId);
    if (toolIds === undefined) {
      toolIds = new Set();
      this.#toolIdsByTurn.set(hit.turnId, toolIds);
    }
    toolIds.add(toolCallId);
    let running = this.#runningToolIdsByTurn.get(hit.turnId);
    if (hit.frame.state === 'running') {
      if (running === undefined) {
        running = new Set();
        this.#runningToolIdsByTurn.set(hit.turnId, running);
      }
      running.add(toolCallId);
    } else {
      running?.delete(toolCallId);
      if (running?.size === 0) this.#runningToolIdsByTurn.delete(hit.turnId);
    }
  }

  private undo(count: number): TranscriptOperation[] {
    if (count <= 0) return [];
    const anchors: { ordinal: number; turnId?: string; messageId?: string }[] = [];
    for (const turnId of this.#undoAnchors) {
      anchors.push({ turnId, ordinal: this.#turnRecordOrdinals.get(turnId) ?? this.#turns.indexOf(turnId) });
    }
    for (const [messageId, record] of this.#deliveryUndoRecords) {
      if (record.anchor) anchors.push({ messageId, ordinal: record.ordinal, turnId: this.#deliveries.get(messageId)?.turnId });
    }
    const anchor = anchors.toSorted((a, b) => b.ordinal - a.ordinal)[count - 1];
    if (anchor === undefined) return [];
    if (anchor.messageId === undefined) {
      const operations = this.removeTurnSuffix(this.#turns.indexOf(anchor.turnId!));
      return [...operations, ...this.removeDeliverySuffix(anchor.ordinal)];
    }
    const retainedTurn = anchor.turnId === undefined ? undefined : this.#turnHeaders.get(anchor.turnId);
    const retainedFrames = [...this.#frameRecords].filter(([, frame]) => frame.operation.turnId === anchor.turnId && frame.ordinal < anchor.ordinal);
    const retainedToolIds = new Set(retainedFrames.flatMap(([, record]) => record.operation.frame.kind === 'tool' ? [record.operation.frame.toolCallId] : []));
    const retainedInteractions = [...this.#interactions.values()].filter((interaction) => interaction.toolCallId !== undefined && retainedToolIds.has(interaction.toolCallId));
    const retainedSteps = [...this.#stepHeaders].filter(([stepId, step]) => step.turnId === anchor.turnId && (this.#stepRecordOrdinals.get(stepId) ?? Infinity) < anchor.ordinal);
    const retainedStepOrdinals = retainedSteps.map(([stepId]) => [stepId, this.#stepRecordOrdinals.get(stepId)!] as const);
    const turnOrdinal = anchor.turnId === undefined ? undefined : this.#turnRecordOrdinals.get(anchor.turnId);
    const isTurnAnchor = anchor.turnId !== undefined && this.#undoAnchors.has(anchor.turnId);
    const isCanonical = anchor.turnId !== undefined && this.#canonicalTurns.has(anchor.turnId);
    const owned = anchor.turnId === undefined ? [] : this.#turnOwnedItemIds.get(anchor.turnId) ?? [];
    const start = anchor.turnId === undefined
      ? this.#turns.findIndex((turnId) => (this.#turnRecordOrdinals.get(turnId) ?? -1) >= anchor.ordinal)
      : this.#turns.indexOf(anchor.turnId);
    const operations: TranscriptOperation[] = start < 0 ? [] : this.removeTurnSuffix(start).map((op) =>
      op.op === 'items.remove' ? { ...op, ids: op.ids.filter((id) => !owned.includes(id)) } : op,
    );
    operations.push(...this.removeDeliverySuffix(anchor.ordinal));
    if (retainedTurn !== undefined) {
      this.trackTurn(retainedTurn.turnId);
      this.#turnHeaders.set(retainedTurn.turnId, retainedTurn);
      if (turnOrdinal !== undefined) this.#turnRecordOrdinals.set(retainedTurn.turnId, turnOrdinal);
      if (isTurnAnchor) this.#undoAnchors.add(retainedTurn.turnId);
      if (isCanonical) this.#canonicalTurns.add(retainedTurn.turnId);
      this.#turnOwnedItemIds.set(retainedTurn.turnId, owned);
      operations.push({ op: 'turn.upsert', turn: retainedTurn });
      for (const [stepId, step] of retainedSteps) {
        this.storeStep(stepId, step);
        this.#steps.set(step.turnId, { stepId, ordinal: step.ordinal });
        operations.push({ op: 'step.upsert', turnId: step.turnId, step });
      }
      for (const [stepId, ordinal] of retainedStepOrdinals) this.#stepRecordOrdinals.set(stepId, ordinal);
      for (const [key, record] of retainedFrames) {
        this.#frameRecords.set(key, record);
        const { operation } = record;
        if (operation.frame.kind === 'tool') this.storeTool(operation.frame.toolCallId, { turnId: operation.turnId, stepId: operation.stepId, frame: operation.frame });
        operations.push(operation);
      }
      for (const interaction of retainedInteractions) {
        this.#interactions.set(interaction.interactionId, interaction);
        operations.push({ op: 'interaction.upsert', interaction });
      }
      this.#currentTurnId = retainedTurn.turnId;
      this.#currentPromptId = retainedTurn.message?.messageId;
    }
    return operations;
  }

  private removeDeliverySuffix(ordinal: number): TranscriptOperation[] {
    const ids: string[] = [];
    for (const [messageId, record] of this.#deliveryUndoRecords) {
      if (record.ordinal < ordinal) continue;
      if (this.#deliveries.get(messageId)?.turnId === undefined) ids.push(`message-delivery:${messageId}`);
      this.#deliveries.delete(messageId);
      this.#deliveryUndoRecords.delete(messageId);
      for (const [notificationId, deliveredMessageId] of this.#deliveredTaskNotifications) {
        if (deliveredMessageId === messageId) this.#deliveredTaskNotifications.delete(notificationId);
      }
    }
    return ids.length === 0 ? [] : [{ op: 'items.remove', ids }];
  }

  private removeTurns(count: number): TranscriptOperation[] {
    const operations = count === 0 ? [] : this.removeTurnSuffix(Math.max(0, this.#turns.length - count));
    return [...operations, ...this.removeDeliverySuffix(0)];
  }

  private removeTurnSuffix(start: number): TranscriptOperation[] {
    const turns = this.#turns.splice(start);
    if (turns.length === 0) return [];
    const ids = turns.flatMap((turnId) => [turnId, ...(this.#turnOwnedItemIds.get(turnId) ?? [])]);
    const removedToolIds = new Set(turns.flatMap((turnId) => [...(this.#toolIdsByTurn.get(turnId) ?? [])]));
    for (const turnId of turns) {
      this.#turnIds.delete(turnId);
      this.#undoAnchors.delete(turnId);
      this.#canonicalTurns.delete(turnId);
      this.#turnOwnedItemIds.delete(turnId);
      this.#turnHeaders.delete(turnId);
      this.#steps.delete(turnId);
      this.#stepUsages.delete(turnId);
      this.#pendingSteers.delete(turnId);
      this.#pendingTaskNotifications.delete(turnId);
      this.#unpairedSteerCredits.delete(turnId);
      for (const stepId of this.#stepIdsByTurn.get(turnId) ?? []) {
        this.#turnIdByStepId.delete(stepId);
        this.#stepHeaders.delete(stepId);
      }
      this.#stepIdsByTurn.delete(turnId);
      this.#runningStepIdsByTurn.delete(turnId);
      for (const toolCallId of this.#toolIdsByTurn.get(turnId) ?? []) {
        this.#tools.delete(toolCallId);
      }
      this.#toolIdsByTurn.delete(turnId);
      this.#runningToolIdsByTurn.delete(turnId);
    }
    for (const [interactionId, interaction] of this.#interactions) {
      if (interaction.toolCallId !== undefined && removedToolIds.has(interaction.toolCallId)) this.#interactions.delete(interactionId);
    }
    const removed = new Set(turns);
    for (const turnId of turns) this.#turnRecordOrdinals.delete(turnId);
    for (const stepId of this.#stepRecordOrdinals.keys()) {
      if (!this.#stepHeaders.has(stepId)) this.#stepRecordOrdinals.delete(stepId);
    }
    for (const [key, record] of this.#frameRecords) {
      if (removed.has(record.operation.turnId)) this.#frameRecords.delete(key);
    }
    this.#currentTurnId = this.#turns.at(-1);
    this.#currentPromptId = undefined;
    return [{ op: 'items.remove', ids }];
  }
}

export function transcriptFactsFromWire(
  agentId: string,
  records: Iterable<TranscriptWireRecord>,
): TranscriptFact[] {
  const adapter = new TranscriptWireAdapter(agentId);
  const facts: TranscriptFact[] = [];
  for (const record of records) facts.push(...adapter.add(record));
  return facts;
}

function durableRecord(type: string): boolean {
  return (
    type === 'turn.prompt' ||
    type === 'turn.ended' ||
    type === 'task.notified' ||
    type === 'prompt.enqueued' ||
    type === 'prompt.replaced' ||
    type === 'prompt.timing_changed' ||
    type === 'prompt.moved' ||
    type === 'prompt.launch_committed' ||
    type === 'prompt.completed' ||
    type === 'prompt.aborted' ||
    type === 'prompt.steered' ||
    type.startsWith('context.') ||
    type.startsWith('executor.') ||
    type.startsWith('subagent.')
  );
}

function factId(record: TranscriptWireRecord, ordinal: number): string {
  const explicit =
    stringOf(record['id']) ?? stringOf(record['uuid']) ?? stringOf(record['goalId']);
  if (explicit !== undefined) return explicit;
  const event = objectOf(record['event']);
  const eventIdentity = stringOf(event?.['uuid']) ?? stringOf(event?.['parentUuid']);
  if (eventIdentity !== undefined) {
    return `wire:v2:${record.type}:${stringOf(event?.['type']) ?? 'event'}:${eventIdentity}`;
  }
  return record.time === undefined
    ? `wire:v2:r${ordinal}:${record.type}`
    : `wire:v2:${record.type}:t${record.time}:h${hashText(JSON.stringify(record))}`;
}

interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: string;
}

function bundledSkillActivations(value: unknown): readonly BundledSkillActivation[] {
  const origin = objectOf(value);
  if (stringOf(origin?.['kind']) !== 'user') return [];
  const activations = arrayOf(origin?.['skillActivations']);
  return activations.flatMap((value) => {
    const activation = objectOf(value);
    const activationId = stringOf(activation?.['activationId']);
    const skillName = stringOf(activation?.['skillName']);
    if (activationId === undefined || skillName === undefined) return [];
    return [
      {
        activationId,
        skillName,
        skillArgs: stringOf(activation?.['skillArgs']),
        skillType: stringOf(activation?.['skillType']),
        skillPath: stringOf(activation?.['skillPath']),
        skillSource: stringOf(activation?.['skillSource']),
      },
    ];
  });
}

function isUndoAnchorOrigin(value: unknown): boolean {
  const origin = objectOf(value);
  const kind = stringOf(origin?.['kind']);
  if (kind === undefined || kind === 'user' || kind === 'peer_thread' || kind === 'agent_message') {
    return true;
  }
  return (
    (kind === 'skill_activation' || kind === 'plugin_command') &&
    stringOf(origin?.['trigger']) === 'user-slash'
  );
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function projectWireQuestionRequest(
  interactionId: string,
  interactionKind: 'approval' | 'question',
  request: unknown,
): unknown {
  if (interactionKind !== 'question') return request;
  const payload = objectOf(request);
  const questions = arrayOf(payload?.['questions']);
  if (questions.length === 0) return request;
  return {
    ...payload,
    question_id: interactionId,
    questions: questions.map((value, questionIndex) => {
      const question = objectOf(value);
      return {
        ...question,
        id: `q_${questionIndex}`,
        options: arrayOf(question?.['options']).map((optionValue, optionIndex) => ({
          ...objectOf(optionValue),
          id: `opt_${questionIndex}_${optionIndex}`,
        })),
      };
    }),
  };
}

function taskNotificationId(sourceId: string, type: string): string | undefined {
  const status = type.startsWith('task.') ? type.slice('task.'.length) : type;
  return status === '' ? undefined : `task:${sourceId}:${status}`;
}

function taskNotificationIdOfRecord(record: TranscriptWireRecord): string | undefined {
  const sourceId = stringOf(record['sourceId']);
  const type = stringOf(record['notificationType']);
  return sourceId === undefined || type === undefined ? undefined : taskNotificationId(sourceId, type);
}

function taskNotificationIdOfMessage(
  message: Readonly<Record<string, unknown>>,
): string | undefined {
  const origin = objectOf(message['origin']);
  const kind = stringOf(origin?.['kind']);
  if (kind === 'task' || kind === 'background_task') {
    const explicit = stringOf(origin?.['notificationId']);
    if (explicit !== undefined) return explicit;
    const taskId = stringOf(origin?.['taskId']);
    const status = stringOf(origin?.['status']);
    if (taskId !== undefined && status !== undefined) return taskNotificationId(taskId, status);
  }
  const text = arrayOf(message['content']).map(textOfPart).join('');
  return /<notification\b[^>]*\bid=["'](task:[^"']+)["']/i.exec(text)?.[1];
}

function legacyOriginKind(origin: unknown): string {
  return stringOf(objectOf(origin)?.['kind']) ?? 'user';
}

function isVisibleLegacyTurnOrigin(
  agentId: string,
  origin: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const kind = stringOf(origin?.['kind']);
  if (kind === 'system_trigger') {
    const name = stringOf(origin?.['name']);
    if (name === 'goal_continuation') return true;
    return name === 'subagent' && agentId !== 'main';
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return stringOf(origin?.['trigger']) === 'user-slash';
  }
  return kind !== 'injection' && kind !== 'retry' && kind !== 'compaction_summary';
}

function mapOrigin(value: unknown): TurnOrigin {
  const origin = objectOf(value);
  const kind = stringOf(origin?.['kind']);
  if (kind === 'user') return { kind: 'user', payload: value };
  if (kind === 'cron_job') return { kind: 'cron', taskId: stringOf(origin?.['jobId']), payload: value };
  if (kind === 'task' || kind === 'background_task') {
    const taskId = stringOf(origin?.['taskId']);
    return taskId === undefined ? { kind: 'other', payload: value } : { kind: 'task', taskId, payload: value };
  }
  if (kind === 'compaction_summary') return { kind: 'compaction', payload: value };
  return { kind: 'other', payload: value };
}

function turnState(value: unknown): 'completed' | 'failed' | 'cancelled' {
  if (value === 'failed' || value === 'blocked') return 'failed';
  if (value === 'cancelled') return 'cancelled';
  return 'completed';
}

function usageOf(value: unknown):
  | { readonly inputOther: number; readonly output: number; readonly inputCacheRead: number; readonly inputCacheCreation: number }
  | undefined {
  const usage = objectOf(value);
  if (usage === undefined) return undefined;
  const inputOther = numberOf(usage['inputOther']);
  const output = numberOf(usage['output']);
  const inputCacheRead = numberOf(usage['inputCacheRead']);
  const inputCacheCreation = numberOf(usage['inputCacheCreation']);
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function mediaOf(value: Readonly<Record<string, unknown>> | undefined):
  | {
      readonly kind: 'image' | 'video' | 'audio';
      readonly source?: AttachmentSource;
      readonly name?: string;
    }
  | undefined {
  const type = stringOf(value?.['type']);
  if (
    type !== 'image_url' &&
    type !== 'video_url' &&
    type !== 'audio_url' &&
    type !== 'image' &&
    type !== 'video' &&
    type !== 'audio'
  ) {
    return undefined;
  }
  const kind: 'image' | 'video' | 'audio' =
    type === 'image' || type === 'image_url'
      ? 'image'
      : type === 'video' || type === 'video_url'
        ? 'video'
        : 'audio';
  const key = type === 'image_url' ? 'imageUrl' : type === 'video_url' ? 'videoUrl' : 'audioUrl';
  const ref = type.endsWith('_url') ? objectOf(value?.[key]) : objectOf(value?.['source']);
  const name = stringOf(ref?.['name']) ?? stringOf(value?.['name']);
  const fileId = stringOf(ref?.['id']) ?? stringOf(ref?.['fileId']) ?? stringOf(ref?.['file_id']);
  if (fileId !== undefined) return { kind, source: { kind: 'session_media', fileId }, name };
  const url = stringOf(ref?.['url']);
  if (url === undefined) return { kind, source: undefined, name };
  const daemonRef = /^kimi-file:\/\/([^?]+)/.exec(url)?.[1];
  return {
    kind,
    source:
      daemonRef === undefined
        ? { kind: 'url', url }
        : { kind: 'session_media', fileId: daemonRef },
    name,
  };
}

function mediaPartsOf(values: readonly unknown[]): PendingSteerMedia[] {
  const media: PendingSteerMedia[] = [];
  for (const value of values) {
    const part = mediaOf(objectOf(value));
    if (part !== undefined) media.push(part);
  }
  return media;
}

function textOfPart(value: unknown): string {
  const part = objectOf(value);
  return stringOf(part?.['type']) === 'text' ? (stringOf(part?.['text']) ?? '') : '';
}

function turnIdOf(value: unknown, fallback: string | undefined): string | undefined {
  const raw = stringOf(value);
  if (raw !== undefined && /^\d+$/.test(raw)) return `t${raw}`;
  const n = numberOf(value);
  return n === undefined ? fallback : `t${n}`;
}

function isoOf(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function lineageOf(value: unknown):
  | { readonly replacesMessageId?: string; readonly parentMessageId?: string; readonly rewriteId?: string }
  | undefined {
  const lineage = objectOf(value);
  if (lineage === undefined) return undefined;
  return {
    replacesMessageId: stringOf(lineage['replacesMessageId']),
    parentMessageId: stringOf(lineage['parentMessageId']),
    rewriteId: stringOf(lineage['rewriteId']),
  };
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isGoalStatus(value: string | undefined): value is GoalStatus {
  return value === 'active' || value === 'paused' || value === 'blocked' || value === 'complete';
}

function goalFollowUpTimingOf(value: unknown): 'subagents_done' | 'tasks_done' | undefined {
  return value === 'subagents_done' || value === 'tasks_done' ? value : undefined;
}

function taskKindOf(value: unknown): TranscriptTask['kind'] {
  if (value === 'process') return 'shell';
  if (value === 'agent') return 'subagent';
  return 'other';
}

function taskLifetimeOf(value: unknown): TranscriptTask['lifetime'] {
  return value === 'finite' || value === 'service' ? value : undefined;
}

function taskStateOf(value: unknown): TranscriptTask['state'] | undefined {
  return value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'timed_out' ||
    value === 'killed' ||
    value === 'lost'
    ? value
    : undefined;
}

function executionOf(record: TranscriptWireRecord): TranscriptTurnExecution | undefined {
  const executorId = stringOf(record['executorId']);
  const protocol = stringOf(record['protocol']);
  const resumeMode = stringOf(record['resumeMode']);
  const profileDelivery = stringOf(record['profileDelivery']);
  const fidelity = stringOf(record['fidelity']);
  const losses = arrayOf(record['losses']).filter((value): value is string => typeof value === 'string');
  if (
    executorId === undefined ||
    protocol === undefined ||
    !['live', 'resume', 'load', 'new', 'handoff'].includes(resumeMode ?? '') ||
    !['native', 'first_prompt_preamble'].includes(profileDelivery ?? '') ||
    (fidelity !== 'full' && fidelity !== 'degraded')
  ) {
    return undefined;
  }
  return {
    executorId,
    protocol,
    resumeMode: resumeMode as TranscriptTurnExecution['resumeMode'],
    profileDelivery: profileDelivery as TranscriptTurnExecution['profileDelivery'],
    fidelity,
    losses,
  };
}

function externalPlanItems(value: unknown): TodoItem[] {
  const entries = arrayOf(objectOf(value)?.['entries']);
  const items: TodoItem[] = [];
  for (const candidate of entries) {
    const entry = objectOf(candidate);
    const title = stringOf(entry?.['content']) ?? stringOf(entry?.['title']);
    const status = stringOf(entry?.['status']);
    if (title === undefined) continue;
    items.push({
      title,
      status: status === 'completed' || status === 'done'
        ? 'done'
        : status === 'in_progress'
          ? 'in_progress'
          : 'pending',
    });
  }
  return items;
}

function todoItemsOf(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  const items: TodoItem[] = [];
  for (const candidate of value) {
    const item = objectOf(candidate);
    const title = stringOf(item?.['title']);
    const status = stringOf(item?.['status']);
    if (
      title !== undefined &&
      (status === 'pending' || status === 'in_progress' || status === 'done')
    ) {
      items.push({ title, status });
    }
  }
  return items;
}

function booleanOf(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function deliveryOrigin(value: unknown, messageOrigin: unknown): MessageDelivery['origin'] {
  if (value === 'user' || value === 'queue' || value === 'mailbox' || value === 'recovery' || value === 'injection') return value;
  if (messageOrigin === 'agent_message') return 'mailbox';
  return messageOrigin === undefined || messageOrigin === 'user' ? 'user' : 'injection';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayOf(value: unknown): string[] {
  return arrayOf(value).flatMap((entry) => {
    const text = stringOf(entry);
    return text === undefined ? [] : [text];
  });
}

function promptAppendTimingOf(value: unknown): TranscriptPromptAppendTiming | undefined {
  return value === 'agent_idle' || value === 'subagents_done' || value === 'tasks_done'
    ? value
    : undefined;
}

function promptRecordTime(record: TranscriptWireRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    const numeric = numberOf(value);
    if (numeric !== undefined) return new Date(numeric).toISOString();
  }
  return undefined;
}

function minimalPrompt(promptId: string, record: TranscriptWireRecord): TranscriptPrompt {
  return {
    promptId,
    status: 'queued',
    createdAt:
      promptRecordTime(record, ['createdAt', 'replacedAt', 'changedAt', 'committedAt', 'steeredAt']) ??
      isoOf(record.time) ??
      new Date(0).toISOString(),
  };
}

function promptOrMinimal(
  previous: TranscriptPrompt | undefined,
  promptId: string,
  record: TranscriptWireRecord,
): TranscriptPrompt {
  return previous ?? minimalPrompt(promptId, record);
}

function isTerminalPromptStatus(status: TranscriptPrompt['status']): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'aborted' || status === 'blocked'
  );
}

function projectPromptContent(value: unknown): unknown[] {
  const parts: unknown[] = [];
  for (const raw of arrayOf(value)) {
    const part = objectOf(raw);
    if (part === undefined) continue;
    if (stringOf(part['type']) === 'text') {
      parts.push({ type: 'text', text: stringOf(part['text']) ?? '' });
      continue;
    }
    const media = mediaOf(part);
    if (media === undefined) continue;
    parts.push({
      type: media.kind,
      source:
        media.source === undefined
          ? undefined
          : media.source.kind === 'url'
            ? { kind: 'url', url: media.source.url }
            : media.source.kind === 'file'
              ? { kind: 'file', file_id: media.source.fileId }
              : { kind: 'session_media', file_id: media.source.fileId },
      name: media.name,
    });
  }
  return parts;
}

function replaceSet<T>(target: Set<T>, values: readonly T[]): void {
  target.clear();
  for (const value of values) target.add(value);
}

function replaceMap<K, V>(target: Map<K, V>, entries: readonly (readonly [K, V])[]): void {
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function replaceSetMap<K, V>(
  target: Map<K, Set<V>>,
  entries: readonly (readonly [K, readonly V[]])[],
): void {
  target.clear();
  for (const [key, values] of entries) target.set(key, new Set(values));
}
