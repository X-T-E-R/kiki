import { createHash } from 'node:crypto';

import {
  ISessionExternalDelegationService,
  resumeSessionById,
  type ExternalAuthority,
  type ExternalDispatchView,
  type ExternalEventPage,
  type ExternalInteractionView,
  type ExternalTranscriptItemsPage,
  type ExternalTranscriptL1Item,
  type ExternalTranscriptPage,
  type ExternalTranscriptStep,
  type ExternalTranscriptToolFrame,
  type ExternalTranscriptTurn,
  type ExternalTurnEventPage,
  type ISessionExternalDelegationService as ExternalDelegationService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { PromptOrigin } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type { ApprovalRequest } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type { QuestionRequest } from '@moonshot-ai/agent-core-v2/session/question/question';
import {
  delegationProcedure,
  type DelegationProcedureInput,
  type DelegationProcedureName,
  type DelegationProcedureOutput,
  type SeatKlient,
} from '@moonshot-ai/klient/procedures';
import type { NormalizedExecutorContent, NormalizedExecutorEvent } from '@moonshot-ai/protocol';

import { ensureMainAgent } from '../transport/mainAgent';

export interface ExternalDelegationSeatAuthority {
  readonly seatId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly workspacePath?: string;
}

export class ExternalDelegationProcedureHost {
  constructor(private readonly core: Scope) {}

  async call<Name extends DelegationProcedureName>(
    seat: ExternalDelegationSeatAuthority,
    name: Name,
    input: DelegationProcedureInput<Name>,
    signal?: AbortSignal,
  ): Promise<DelegationProcedureOutput<Name>> {
    const procedure = delegationProcedure(name);
    const canonicalInput = procedure.inputSchema.parse(input) as DelegationProcedureInput<Name>;
    const session = await resumeSessionById(this.core.accessor, seat.sessionId);
    if (session === undefined) throw new Error('Session does not exist.');
    await ensureMainAgent(session);
    const service = session.accessor.get(ISessionExternalDelegationService);
    const output = await execute(service, authorityFor(seat), seat, name, canonicalInput, signal);
    return procedure.outputSchema.parse(output) as DelegationProcedureOutput<Name>;
  }

  klient(seat: ExternalDelegationSeatAuthority): SeatKlient {
    const active = new Set<AbortController>();
    const closedResult = Promise.resolve();
    let closed = false;
    const call = async <Name extends DelegationProcedureName>(
      name: Name,
      input: DelegationProcedureInput<Name>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<DelegationProcedureOutput<Name>> => {
      if (closed) throw new Error('seat klient closed');
      const controller = new AbortController();
      active.add(controller);
      try {
        const signal = options?.signal === undefined
          ? controller.signal
          : AbortSignal.any([controller.signal, options.signal]);
        return await this.call(seat, name, input, signal);
      } finally {
        active.delete(controller);
      }
    };
    const close = (): Promise<void> => {
      if (closed) return closedResult;
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
      return closedResult;
    };
    return {
      call,
      profiles: (input = {}) => call('profiles', input),
      list: (input = {}) => call('list', input),
      dispatch: (input) => call('dispatch', input),
      continue: (input) => call('continue', input),
      send: (input) => call('send', input),
      interactions: (input = {}) => call('interactions', input),
      respond: (input) => call('respond', input),
      status: (input) => call('status', input),
      wait: (input = {}, options) => call('wait', input, options),
      result: (input) => call('result', input),
      events: (input) => call('events', input),
      transcript: (input) => call('transcript', input),
      cancel: (input) => call('cancel', input),
      close,
    };
  }
}

async function execute<Name extends DelegationProcedureName>(
  service: ExternalDelegationService,
  authority: ExternalAuthority,
  seat: ExternalDelegationSeatAuthority,
  name: Name,
  input: DelegationProcedureInput<Name>,
  signal?: AbortSignal,
): Promise<DelegationProcedureOutput<Name>> {
  switch (name) {
    case 'profiles': {
      const root = await service.list(authority);
      return {
        profiles: root.dispatchables.filter((entry) => entry.kind === 'named'),
        binding: binding(seat),
      } as DelegationProcedureOutput<Name>;
    }
    case 'list': {
      const root = await service.list(authority);
      return {
        version: root.version,
        delegationId: root.delegationId,
        lifecycle: root.lifecycle,
        dispatchables: root.dispatchables,
        children: root.children,
        continuations: root.continuations.map(publicDispatch),
        binding: binding(seat),
      } as DelegationProcedureOutput<Name>;
    }
    case 'dispatch': {
      const value = input as DelegationProcedureInput<'dispatch'>;
      return publicDispatch(await service.dispatch({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'continue': {
      const value = input as DelegationProcedureInput<'continue'>;
      return publicDispatch(await service.continue({ authority, ...value })) as DelegationProcedureOutput<Name>;
    }
    case 'send': {
      const value = input as DelegationProcedureInput<'send'>;
      const accepted = await service.send({
        authority,
        taskName: value.taskName,
        message: value.message,
        idempotencyKey: value.idempotencyKey,
      });
      return {
        message: {
          messageId: accepted.message.messageId,
          sourceTaskName: accepted.message.sourceTaskName,
          targetTaskName: accepted.message.targetTaskName,
          content: accepted.message.content,
          acceptedAt: accepted.message.acceptedAt,
          targetSeq: accepted.message.targetSeq,
        },
        deduplicated: accepted.deduplicated,
        delivery: accepted.delivery,
        payloadConflict: accepted.payloadConflict,
      } as DelegationProcedureOutput<Name>;
    }
    case 'interactions': {
      const value = input as DelegationProcedureInput<'interactions'>;
      const page = await service.interactions({ authority, cursor: value.cursor });
      return {
        items: page.items.map(publicInteraction),
        nextCursor: page.nextCursor,
      } as DelegationProcedureOutput<Name>;
    }
    case 'respond': {
      const value = input as DelegationProcedureInput<'respond'>;
      return await service.respond({ authority, ...value }) as DelegationProcedureOutput<Name>;
    }
    case 'status': {
      const value = input as DelegationProcedureInput<'status'>;
      return publicDispatch(await service.status({ authority, dispatchId: value.dispatchId })) as DelegationProcedureOutput<Name>;
    }
    case 'wait': {
      const value = input as DelegationProcedureInput<'wait'>;
      const waited = await service.wait({ authority, ...value, signal });
      return {
        waitStatus: waited.waitStatus,
        waitedMs: waited.waitedMs,
        dispatch: waited.dispatch === undefined ? undefined : publicDispatch(waited.dispatch),
        completedDuringWait: waited.completedDuringWait.map(publicDispatch),
        interactions: waited.interactions.map(publicInteraction),
      } as DelegationProcedureOutput<Name>;
    }
    case 'result': {
      const value = input as DelegationProcedureInput<'result'>;
      const page = await service.result({ authority, ...value });
      return {
        dispatch: publicDispatch(page.dispatch),
        text: page.text,
        nextCursor: page.nextCursor,
      } as DelegationProcedureOutput<Name>;
    }
    case 'events': {
      const value = input as DelegationProcedureInput<'events'>;
      const page = await service.events({ authority, ...value });
      return publicEvents(page) as DelegationProcedureOutput<Name>;
    }
    case 'transcript': {
      const value = input as DelegationProcedureInput<'transcript'>;
      const page = await service.transcript({ authority, ...value });
      return publicTranscript(page) as DelegationProcedureOutput<Name>;
    }
    case 'cancel': {
      const value = input as DelegationProcedureInput<'cancel'>;
      return publicDispatch(await service.cancel({ authority, dispatchId: value.dispatchId })) as DelegationProcedureOutput<Name>;
    }
  }
}

function binding(seat: ExternalDelegationSeatAuthority) {
  return {
    version: 1 as const,
    seatId: seat.seatId,
    sessionId: seat.sessionId,
    principalId: seat.principalId,
    workspacePath: seat.workspacePath,
  };
}

function publicDispatch(value: ExternalDispatchView): Omit<ExternalDispatchView, 'agentId'> {
  return {
    dispatchId: value.dispatchId,
    target: value.target,
    taskName: value.taskName,
    profileName: value.profileName,
    actualProfile: value.actualProfile,
    modelAlias: value.modelAlias,
    thinkingEffort: value.thinkingEffort,
    status: value.status,
    nextStep: value.nextStep,
    continueHint: value.continueHint,
    createdAt: value.createdAt,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    continuationOf: value.continuationOf,
    usage: value.usage,
    errorCode: value.errorCode,
  };
}

function authorityFor(seat: ExternalDelegationSeatAuthority): ExternalAuthority {
  return {
    principalFingerprint: sha256(`principal:v1:${seat.principalId}`),
    authorityFingerprint: sha256(`authority:v2:${seat.principalId}:${seat.seatId}:external-delegation`),
    configFingerprint: sha256('config:v2:main+named:immutable-new-child-bindings'),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicInteraction(value: ExternalInteractionView) {
  return value.kind === 'approval'
    ? {
        interactionId: value.interactionId,
        kind: value.kind,
        taskName: value.taskName,
        payload: publicApprovalRequest(value.payload as ApprovalRequest),
        createdAt: value.createdAt,
      }
    : {
        interactionId: value.interactionId,
        kind: value.kind,
        taskName: value.taskName,
        payload: publicQuestionRequest(value.payload as QuestionRequest),
        createdAt: value.createdAt,
      };
}

function publicApprovalRequest(request: ApprovalRequest) {
  return {
    toolName: request.toolName,
    action: request.action,
    display: request.display,
  };
}

function publicQuestionRequest(request: QuestionRequest) {
  return {
    questions: request.questions.map((question) => ({
      question: question.question,
      header: question.header,
      body: question.body,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      multiSelect: question.multiSelect,
      otherLabel: question.otherLabel,
      otherDescription: question.otherDescription,
    })),
  };
}

function publicEvents(page: ExternalEventPage | ExternalTurnEventPage) {
  return {
    items: page.items.map((item) => 'event' in item
      ? {
          seq: item.seq,
          dispatchId: item.dispatchId,
          at: item.at,
          event: publicExecutorEvent(item.event),
        }
      : {
          seq: item.seq,
          dispatchId: item.dispatchId,
          type: item.type,
          at: item.at,
          message: item.message,
        }),
    nextCursor: page.nextCursor,
    truncated_before_seq: 'truncated_before_seq' in page ? page.truncated_before_seq : undefined,
  };
}

function publicExecutorContent(content: NormalizedExecutorContent): NormalizedExecutorContent {
  switch (content.type) {
    case 'text':
      return { type: content.type, text: content.text };
    case 'image':
      return { type: content.type, mimeType: content.mimeType, data: content.data };
    case 'resource_link':
      return { type: content.type, uri: content.uri, name: content.name };
    case 'opaque':
      return { type: content.type, contentType: content.contentType };
  }
}

function publicExecutorEvent(event: NormalizedExecutorEvent): NormalizedExecutorEvent {
  switch (event.type) {
    case 'message.delta':
      return {
        type: event.type,
        role: event.role,
        messageId: event.messageId,
        content: publicExecutorContent(event.content),
      };
    case 'thought.delta':
      return {
        type: event.type,
        messageId: event.messageId,
        content: publicExecutorContent(event.content),
      };
    case 'tool.call':
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        title: event.title,
        kind: event.kind,
        status: event.status,
        rawInput: event.rawInput,
        content: event.content,
        locations: event.locations,
      };
    case 'tool.update':
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        title: event.title,
        kind: event.kind,
        status: event.status,
        rawInput: event.rawInput,
        rawOutput: event.rawOutput,
        content: event.content,
        locations: event.locations,
      };
    case 'plan.update':
      return { type: event.type, plan: event.plan, unstable: event.unstable };
    case 'plan.remove':
      return { type: event.type, planId: event.planId, unstable: event.unstable };
    case 'commands.update':
      return { type: event.type, commands: event.commands };
    case 'mode.update':
      return { type: event.type, currentModeId: event.currentModeId };
    case 'config.update':
      return { type: event.type, configOptions: event.configOptions };
    case 'session.info':
      return { type: event.type, title: event.title, meta: event.meta };
    case 'usage':
      return { type: event.type, used: event.used, size: event.size, cost: event.cost };
    case 'unknown':
      return { type: event.type, updateType: event.updateType };
  }
}

function publicTranscript(page: ExternalTranscriptPage | ExternalTranscriptItemsPage) {
  if ('cursor' in page) {
    return {
      items: page.items.map(publicTranscriptItem),
      cursor: page.cursor,
      nextCursor: page.nextCursor,
    };
  }
  return {
    items: page.items.map((item) => ({
      index: item.index,
      role: item.role,
      text: item.text,
    })),
    nextCursor: page.nextCursor,
  };
}

function publicTranscriptItem(item: ExternalTranscriptL1Item): ExternalTranscriptL1Item {
  switch (item.kind) {
    case 'turn':
      return publicTranscriptTurn(item);
    case 'marker':
      return {
        kind: item.kind,
        markerId: item.markerId,
        marker: item.marker,
        payload: item.payload,
        at: item.at,
      };
    case 'taskref':
      return {
        kind: item.kind,
        refId: item.refId,
        taskId: item.taskId,
        at: item.at,
      };
  }
}

function publicTranscriptTurn(turn: ExternalTranscriptTurn) {
  return {
    kind: turn.kind,
    turnId: turn.turnId,
    ordinal: turn.ordinal,
    state: turn.state,
    origin: publicPromptOrigin(turn.origin as PromptOrigin),
    prompt: turn.prompt,
    steps: turn.steps.map(publicTranscriptStep),
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    usage: turn.usage,
  };
}

function publicPromptOrigin(origin: PromptOrigin) {
  switch (origin.kind) {
    case 'user':
      return { kind: origin.kind, skillActivations: origin.skillActivations };
    case 'skill_activation':
      return {
        kind: origin.kind,
        activationId: origin.activationId,
        skillName: origin.skillName,
        skillArgs: origin.skillArgs,
        trigger: origin.trigger,
        skillType: origin.skillType,
        skillPath: origin.skillPath,
        skillSource: origin.skillSource,
      };
    case 'plugin_command':
      return {
        kind: origin.kind,
        activationId: origin.activationId,
        pluginId: origin.pluginId,
        commandName: origin.commandName,
        commandArgs: origin.commandArgs,
        trigger: origin.trigger,
      };
    case 'injection':
      return {
        kind: origin.kind,
        variant: origin.variant,
        ownerPromptId: origin.ownerPromptId,
        disclosure: origin.disclosure,
      };
    case 'shell_command':
      return { kind: origin.kind, phase: origin.phase, isError: origin.isError };
    case 'compaction_summary':
      return { kind: origin.kind };
    case 'system_trigger':
      return { kind: origin.kind, name: origin.name };
    case 'task':
      return {
        kind: origin.kind,
        taskId: origin.taskId,
        status: origin.status,
        notificationId: origin.notificationId,
      };
    case 'cron_job':
      return {
        kind: origin.kind,
        jobId: origin.jobId,
        cron: origin.cron,
        recurring: origin.recurring,
        coalescedCount: origin.coalescedCount,
        stale: origin.stale,
      };
    case 'cron_missed':
      return { kind: origin.kind, count: origin.count };
    case 'hook_result':
      return { kind: origin.kind, event: origin.event, blocked: origin.blocked };
    case 'retry':
      return { kind: origin.kind, trigger: origin.trigger };
    case 'peer_thread':
      return {
        kind: origin.kind,
        source: {
          hostId: origin.source.hostId,
          workspaceId: origin.source.workspaceId,
          sessionId: origin.source.sessionId,
        },
        messageId: origin.messageId,
        acceptedAt: origin.acceptedAt,
      };
    case 'agent_message':
      return {
        kind: origin.kind,
        messageId: origin.messageId,
        senderTaskName: origin.senderTaskName,
      };
  }
}

function publicTranscriptStep(step: ExternalTranscriptStep): ExternalTranscriptStep {
  return {
    kind: step.kind,
    stepId: step.stepId,
    turnId: step.turnId,
    ordinal: step.ordinal,
    state: step.state,
    frames: step.frames.map(publicTranscriptFrame),
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    usage: step.usage,
  };
}

function publicTranscriptFrame(
  frame: ExternalTranscriptStep['frames'][number],
): ExternalTranscriptStep['frames'][number] {
  switch (frame.kind) {
    case 'text':
      return {
        kind: frame.kind,
        frameId: frame.frameId,
        role: frame.role,
        text: frame.text,
      };
    case 'thinking':
      return {
        kind: frame.kind,
        frameId: frame.frameId,
        text: frame.text,
      };
    case 'tool':
      return publicTranscriptToolFrame(frame);
  }
}

function publicTranscriptToolFrame(frame: ExternalTranscriptToolFrame): ExternalTranscriptToolFrame {
  return {
    kind: frame.kind,
    frameId: frame.frameId,
    toolCallId: frame.toolCallId,
    name: frame.name,
    state: frame.state,
    input: frame.input,
    output: frame.output,
    display: frame.display,
    progress: frame.progress,
    startedAt: frame.startedAt,
    endedAt: frame.endedAt,
  };
}
