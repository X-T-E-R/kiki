import type { TranscriptFact } from './reducer';
import type { AttachmentSource } from '../model/attachment';
import type { ToolCallFrame } from '../model/frame';
import { projectInteractionEndState, type TranscriptInteraction } from '../model/interaction';
import type { GoalMeta, GoalStatus } from '../model/meta';
import type { TranscriptTask } from '../model/task';
import type { TodoItem } from '../model/todo';
import type { TurnHeader, TranscriptOperation } from '../ops/operation';
import type { StepUsage, TurnOrigin } from '../model/turn';

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
}

export class TranscriptWireAdapter {
  readonly #turns: string[] = [];
  readonly #steps = new Map<string, { stepId: string; ordinal: number }>();
  readonly #tools = new Map<string, { turnId: string; stepId: string; frame: ToolCallFrame }>();
  readonly #stepUsages = new Map<string, StepUsage[]>();
  readonly #tasks = new Map<string, TranscriptTask>();
  readonly #interactions = new Map<string, TranscriptInteraction>();
  readonly #canonicalTurns = new Set<string>();
  readonly #undoAnchors = new Set<string>();
  readonly #turnOwnedItemIds = new Map<string, string[]>();
  #goal: GoalMeta | undefined;
  #plan: { readonly reviewPath?: string; readonly version?: number } | undefined;
  #recordOrdinal = 0;
  #legacyTurnOrdinal = 0;
  #currentTurnId: string | undefined;
  #currentPromptId: string | undefined;

  constructor(
    readonly agentId: string,
    readonly lookups?: TranscriptWireAdapterLookups,
  ) {}

  add(record: TranscriptWireRecord): TranscriptFact[] {
    const ordinal = this.#recordOrdinal++;
    const operations = this.operations(record, ordinal);
    if (operations.length === 0) return [];
    return [
      {
        factId: factId(record, ordinal),
        durability: durableRecord(record.type) ? 'durable' : 'transient',
        operations,
      },
    ];
  }

  finish(): TranscriptFact[] {
    const operations: TranscriptOperation[] = [];
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
    return this.supplemental(record, ordinal);
  }

  private supplemental(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
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
      this.#goal = {
        objective: stringOf(record['objective']) ?? '',
        status: 'active',
        completionCriterion: stringOf(record['completionCriterion']),
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
        this.#goal = {
          ...this.#goal,
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
      const previous = this.#tasks.get(taskId);
      const state = taskStateOf(info?.['status']) ?? previous?.state ?? 'running';
      const task: TranscriptTask = {
        taskId,
        kind: taskKindOf(info?.['kind']),
        state,
        detached: booleanOf(info?.['detached']) ?? previous?.detached ?? true,
        description: stringOf(info?.['description']) ?? previous?.description,
        agentId: stringOf(info?.['agentId']) ?? previous?.agentId,
        outputTail: stringOf(record['outputTail']) ?? previous?.outputTail ?? '',
        startedAt: previous?.startedAt ?? isoOf(numberOf(info?.['startedAt'])),
        endedAt: isoOf(numberOf(info?.['endedAt'])) ?? previous?.endedAt,
      };
      this.#tasks.set(taskId, task);
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
        });
      }
      if (task.kind !== 'subagent' || task.state !== 'running') {
        operations.push({ op: 'task.upsert', task });
      }
      return operations;
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
      const request = record['request'];
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
    if (
      record.type === 'turn.cancel' &&
      record['target'] === 'active' &&
      record['reason'] === 'user_cancelled'
    ) {
      return [this.marker(record, ordinal, 'interruption')];
    }
    return [];
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
    if (!this.#turns.includes(turnId)) this.#turns.push(turnId);
    if (isUndoAnchorOrigin(record['origin'])) this.#undoAnchors.add(turnId);
    const input = arrayOf(record['input']);
    const activations = bundledSkillActivations(record['origin']);
    const openingInput = input.slice(activations.length);
    const prompt = openingInput.map(textOfPart).join('');
    const promptId = stringOf(record['promptId']) ?? stringOf(record['messageId']);
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
          source: media.source,
          owner: { kind: 'turn', turnId },
        },
      });
    }
    operations.push({
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: turnOrdinal,
        state: 'running',
        origin: mapOrigin(record['origin']),
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
        prompt: prompt.length > 0 ? prompt : undefined,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        startedAt: isoOf(record.time),
      },
    });
    return operations;
  }

  private turnSteer(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    const turnId = turnIdOf(record['turnId'], this.#currentTurnId);
    if (turnId === undefined) return [];
    const step = this.#steps.get(turnId);
    if (step === undefined) return [];
    const input = arrayOf(record['input']);
    const promptId = stringOf(record['promptId']) ?? `legacy:v1:r${ordinal}:steer`;
    const text = input.map(textOfPart).join('');
    if (text.length === 0) return [];
    return [
      {
        op: 'frame.upsert',
        turnId,
        stepId: step.stepId,
        frame: {
          kind: 'text',
          frameId: promptId,
          part: {
            partId: promptId,
            messageId: promptId,
            revision: numberOf(record['revision']) ?? 0,
            provenance: {
              source: stringOf(record['promptId']) === undefined ? 'legacy-wire' : 'engine',
              recordOrdinal: stringOf(record['promptId']) === undefined ? ordinal : undefined,
            },
          },
          role: 'user',
          text,
          origin: record['origin'],
        },
      },
    ];
  }

  private legacyMessage(record: TranscriptWireRecord, ordinal: number): TranscriptOperation[] {
    const message = objectOf(record['message']);
    const role = stringOf(message?.['role']);
    if (message === undefined || role === undefined || role === 'system') return [];
    const messageId = stringOf(message['id']) ?? `legacy:v1:r${ordinal}:message`;
    const content = arrayOf(message['content']);
    if (role === 'user') {
      if (messageId === this.#currentPromptId) return [];
      const origin = objectOf(message['origin']);
      if (stringOf(origin?.['kind']) === 'injection') return this.legacyInjectedMessage(message, ordinal);
      const turnOrdinal = this.#legacyTurnOrdinal++;
      if (!isVisibleLegacyTurnOrigin(this.agentId, origin)) return [];
      const turnId = `t${turnOrdinal}`;
      this.#currentTurnId = turnId;
      this.#currentPromptId = messageId;
      if (!this.#turns.includes(turnId)) this.#turns.push(turnId);
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
            source: media.source,
            owner: { kind: 'turn', turnId },
          },
        });
      }
      const prompt = openingContent.map(textOfPart).join('');
      operations.push({
        op: 'turn.upsert',
        turn: {
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
        },
      });
      return operations;
    }
    if (role === 'assistant') return this.legacyAssistant(message, ordinal, record.time);
    if (role === 'tool') {
      const toolCallId = stringOf(message['toolCallId']);
      if (toolCallId === undefined) return [];
      return this.toolResult({
        toolCallId,
        result: {
          output: content.map(textOfPart).join(''),
          isError: message['isError'] === true,
        },
      });
    }
    return [];
  }

  private legacyInjectedMessage(
    message: Readonly<Record<string, unknown>>,
    ordinal: number,
  ): TranscriptOperation[] {
    const turnId = this.#currentTurnId;
    const step = turnId === undefined ? undefined : this.#steps.get(turnId);
    if (turnId === undefined || step === undefined) return [];
    const messageId = stringOf(message['id']) ?? `legacy:v1:r${ordinal}:message`;
    return [
      {
        op: 'frame.upsert',
        turnId,
        stepId: step.stepId,
        frame: {
          kind: 'text',
          frameId: messageId,
          part: {
            partId: messageId,
            messageId,
            revision: 0,
            provenance: { source: 'legacy-wire', recordOrdinal: ordinal },
          },
          role: 'user',
          text: arrayOf(message['content']).map(textOfPart).join(''),
          origin: message['origin'],
        },
      },
    ];
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
    const operations: TranscriptOperation[] = [
      {
        op: 'step.upsert',
        turnId,
        step: {
          kind: 'step',
          stepId: step.stepId,
          turnId,
          ordinal: step.ordinal,
          state: 'completed',
          endedAt: isoOf(time),
        },
      },
    ];
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
      };
      this.#tools.set(toolCallId, { turnId, stepId: step.stepId, frame });
      operations.push({ op: 'frame.upsert', turnId, stepId: step.stepId, frame });
    }
    const previous = this.lookups?.turn?.(turnId);
    if (previous !== undefined) {
      operations.push({
        op: 'turn.upsert',
        turn: { ...previous, state: 'completed', endedAt: isoOf(time) },
      });
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
      this.#steps.set(turnId, { stepId, ordinal: stepOrdinal });
      return [
        this.ensureTurn(turnId),
        {
          op: 'step.upsert',
          turnId,
          step: {
            kind: 'step',
            stepId,
            turnId,
            ordinal: stepOrdinal,
            state: 'running',
            startedAt: isoOf(time),
          },
        },
      ];
    }
    if (type === 'step.end') return this.stepEnd(event, time);
    if (type === 'content.part') return this.contentPart(event, ordinal);
    if (type === 'tool.call') return this.toolCall(event, ordinal);
    if (type === 'tool.result') return this.toolResult(event);
    return [];
  }

  private stepEnd(
    event: Readonly<Record<string, unknown>>,
    time: number | undefined,
  ): TranscriptOperation[] {
    const stepId = stringOf(event['uuid']);
    const turnId = turnIdOf(event['turnId'], this.turnForStep(stepId));
    if (turnId === undefined || stepId === undefined) return [];
    const ordinal = numberOf(event['step']) ?? this.#steps.get(turnId)?.ordinal ?? 1;
    const usage = usageOf(event['usage']);
    if (usage !== undefined) {
      const usages = this.#stepUsages.get(turnId) ?? [];
      usages.push(usage);
      this.#stepUsages.set(turnId, usages);
    }
    const operations: TranscriptOperation[] = [
      {
        op: 'step.upsert',
        turnId,
        step: {
          kind: 'step',
          stepId,
          turnId,
          ordinal,
          state: 'completed',
          endedAt: isoOf(time),
          usage,
          finishReason:
            stringOf(event['finishReason']) ??
            stringOf(event['rawFinishReason']) ??
            stringOf(event['providerFinishReason']),
          timing: {
            llmFirstTokenLatencyMs: numberOf(event['llmFirstTokenLatencyMs']),
            llmStreamDurationMs: numberOf(event['llmStreamDurationMs']),
            llmRequestBuildMs: numberOf(event['llmRequestBuildMs']),
            llmServerFirstTokenMs: numberOf(event['llmServerFirstTokenMs']),
            llmServerDecodeMs: numberOf(event['llmServerDecodeMs']),
            llmClientConsumeMs: numberOf(event['llmClientConsumeMs']),
          },
        },
      },
    ];
    if (!this.#canonicalTurns.has(turnId)) {
      const previous = this.lookups?.turn?.(turnId);
      if (previous !== undefined) {
        operations.push({
          op: 'turn.upsert',
          turn: { ...previous, state: 'completed', endedAt: isoOf(time) },
        });
      }
    }
    return operations;
  }

  private contentPart(
    event: Readonly<Record<string, unknown>>,
    ordinal: number,
  ): TranscriptOperation[] {
    const stepId = stringOf(event['stepUuid']);
    const turnId = turnIdOf(event['turnId'], this.turnForStep(stepId));
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
  ): TranscriptOperation[] {
    const toolCallId = stringOf(event['toolCallId']);
    const stepId = stringOf(event['stepUuid']);
    const turnId = turnIdOf(event['turnId'], this.turnForStep(stepId));
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
    };
    const hit = { turnId, stepId, frame };
    this.#tools.set(toolCallId, hit);
    return [{ op: 'frame.upsert', ...hit }];
  }

  private toolResult(event: Readonly<Record<string, unknown>>): TranscriptOperation[] {
    const toolCallId = stringOf(event['toolCallId']);
    if (toolCallId === undefined) return [];
    const hit = this.#tools.get(toolCallId) ?? this.lookups?.tool?.(toolCallId);
    if (hit === undefined) return [];
    const result = objectOf(event['result']);
    const output = result?.['output'];
    const isError = result?.['isError'] === true;
    const frame: ToolCallFrame = {
      ...hit.frame,
      state: isError ? 'error' : 'done',
      output,
      error: isError && typeof output === 'string' ? output : undefined,
    };
    this.#tools.set(toolCallId, { ...hit, frame });
    return [{ op: 'frame.upsert', turnId: hit.turnId, stepId: hit.stepId, frame }];
  }

  private turnEnded(record: TranscriptWireRecord): TranscriptOperation[] {
    const n = numberOf(record['turnId']);
    if (n === undefined) return [];
    const turnId = `t${n}`;
    const previous = this.lookups?.turn?.(turnId);
    if (previous === undefined && !this.#turns.includes(turnId)) return [];
    const stepUsages = this.#stepUsages.get(turnId);
    this.#stepUsages.delete(turnId);
    const usage =
      stepUsages === undefined || stepUsages.length === 0
        ? undefined
        : {
            inputTokens: stepUsages.reduce(
              (sum, current) => sum + current.inputOther + current.inputCacheCreation,
              0,
            ),
            outputTokens: stepUsages.reduce((sum, current) => sum + current.output, 0),
            cachedTokens: stepUsages.reduce((sum, current) => sum + current.inputCacheRead, 0),
          };
    const operations: TranscriptOperation[] = [
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn',
          turnId,
          ordinal: n,
          state: turnState(record['reason']),
          origin: previous?.origin ?? { kind: 'other' },
          message: previous?.message,
          prompt: previous?.prompt,
          attachmentIds: previous?.attachmentIds,
          startedAt: previous?.startedAt,
          endedAt: isoOf(record.time),
          usage,
          durationMs: numberOf(record['durationMs']),
          error: stringOf(objectOf(record['error'])?.['message']),
        },
      },
    ];
    if (record['reason'] === 'cancelled' && record['interruptReason'] === 'user_cancelled') {
      operations.push({
        op: 'marker.upsert',
        item: {
          kind: 'marker',
          markerId: `turn:${n}:interruption`,
          marker: 'interruption',
          payload: { turnId: n, reason: record['interruptReason'] },
          at: isoOf(record.time),
        },
      });
    }
    return operations;
  }

  private ensureTurn(turnId: string): TranscriptOperation {
    const n = Number(turnId.slice(1));
    if (!this.#turns.includes(turnId)) this.#turns.push(turnId);
    const previous = this.lookups?.turn?.(turnId);
    return {
      op: 'turn.upsert',
      turn:
        previous === undefined
          ? {
              kind: 'turn',
              turnId,
              ordinal: Number.isFinite(n) ? n : this.#turns.length - 1,
              state: 'running',
              origin: { kind: 'other' },
            }
          : { ...previous, state: 'running' },
    };
  }

  private turnForStep(stepId: string | undefined): string | undefined {
    if (stepId === undefined) return undefined;
    for (const [turnId, step] of this.#steps) {
      if (step.stepId === stepId) return turnId;
    }
    return undefined;
  }

  private undo(count: number): TranscriptOperation[] {
    const target = Math.max(0, count);
    if (target === 0) return [];
    let anchors = 0;
    for (let index = this.#turns.length - 1; index >= 0; index -= 1) {
      const turnId = this.#turns[index]!;
      if (!this.#undoAnchors.has(turnId)) continue;
      anchors += 1;
      if (anchors === target) return this.removeTurnSuffix(index);
    }
    return [];
  }

  private removeTurns(count: number): TranscriptOperation[] {
    if (count === 0) return [];
    return this.removeTurnSuffix(Math.max(0, this.#turns.length - count));
  }

  private removeTurnSuffix(start: number): TranscriptOperation[] {
    const turns = this.#turns.splice(start);
    if (turns.length === 0) return [];
    const ids = turns.flatMap((turnId) => [turnId, ...(this.#turnOwnedItemIds.get(turnId) ?? [])]);
    for (const turnId of turns) {
      this.#undoAnchors.delete(turnId);
      this.#canonicalTurns.delete(turnId);
      this.#turnOwnedItemIds.delete(turnId);
      this.#steps.delete(turnId);
      this.#stepUsages.delete(turnId);
      for (const [toolCallId, tool] of this.#tools) {
        if (tool.turnId === turnId) this.#tools.delete(toolCallId);
      }
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
  return type === 'turn.prompt' || type === 'turn.ended' || type.startsWith('context.');
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
  | { readonly kind: 'image' | 'video' | 'audio'; readonly source?: AttachmentSource }
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
  const fileId = stringOf(ref?.['id']) ?? stringOf(ref?.['fileId']) ?? stringOf(ref?.['file_id']);
  if (fileId !== undefined) return { kind, source: { kind: 'session_media', fileId } };
  const url = stringOf(ref?.['url']);
  if (url === undefined) return { kind, source: undefined };
  const daemonRef = /^kimi-file:\/\/([^?]+)/.exec(url)?.[1];
  return {
    kind,
    source:
      daemonRef === undefined
        ? { kind: 'url', url }
        : { kind: 'session_media', fileId: daemonRef },
  };
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

function taskKindOf(value: unknown): TranscriptTask['kind'] {
  if (value === 'process') return 'shell';
  if (value === 'agent') return 'subagent';
  return 'other';
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

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
