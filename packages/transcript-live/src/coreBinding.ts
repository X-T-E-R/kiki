import {
  IAgentLifecycleService,
  IAgentActivityView,
  IAgentPromptService,
  IAgentTaskService,
  IEventBus,
  ISessionMetadata,
  ISessionInteractionService,
  MAIN_AGENT_ID,
  type AgentMeta,
  type IDisposable,
  type IAgentScopeHandle,
  type Interaction,
  type ISessionScopeHandle,
  type PromptSnapshot,
} from '@kiki/agent-core-v2';
import {
  TranscriptFactReducer,
  TranscriptWireAdapter,
  type AgentDescriptor,
  type TranscriptChangeEvent,
  type TranscriptFact,
  type TranscriptPrompt,
  type TranscriptStore,
  type TranscriptWireRecord,
} from '@kiki/transcript';

import { projectPromptContentParts } from './promptProjection';
import {
  resolveSubagentDisplayName,
  subagentParentAgentId,
  subagentUserLabel,
} from './subagentProjection';
import {
  AgentTranscriptLiveAdapter,
  type LiveAdapterBusEvent,
  type LiveAdapterInteraction,
} from './liveAdapter';

/** Minimal warn sink (matches `JournalLogger`). */
export interface TranscriptBindingLogger {
  warn(obj: unknown, msg: string): void;
}

/** The live binding plus its deferred seeding hook. */
export interface TranscriptBinding extends IDisposable {
  seedPendingInteractions(agentId?: string): void;
  seedRunningTasks(agentId?: string): void;
  seedPrompts(agentId?: string): void;
  finishReplay(agentId: string): void;
}

export function bindSessionTranscript(
  store: TranscriptStore,
  session: ISessionScopeHandle,
  logger?: TranscriptBindingLogger,
  onOps?: (event: TranscriptChangeEvent) => void,
  bufferDuringReplay: boolean = false,
): TranscriptBinding {
  const agents = session.accessor.get(IAgentLifecycleService);
  const interactions = session.accessor.get(ISessionInteractionService);
  const disposables: IDisposable[] = [];
  const agentDisposables = new Map<string, IDisposable[]>();
  const subscribedAgents = new Set<string>();
  const liveAdapters = new Map<string, AgentTranscriptLiveAdapter>();
  const reducers = new Map<string, TranscriptFactReducer>();
  const wireAdapters = new Map<string, TranscriptWireAdapter>();
  const bufferedEvents = new Map<string, TranscriptWireRecord[]>();
  const replayingAgents = new Set<string>();
  const interactionAgents = new Map<string, string>();
  const knownInteractions = new Set<string>();
  const unseeded = new Map<string, Interaction>();
  const earlyResolves = new Map<string, { agentId: string; response: unknown }>();
  const seededAgents = new Set<string>();
  let transientFactSeq = 0;
  let seededAll = false;
  const isSeeded = (agentId: string): boolean => seededAll || seededAgents.has(agentId);

  const toolFrameFor = (agentId: string, toolCallId: string) => {
    const transcript = store.getAgent(agentId);
    if (transcript === undefined) return undefined;
    for (const item of transcript.getItems()) {
      if (item.kind !== 'turn') continue;
      for (const step of item.steps) {
        for (const frame of step.frames) {
          if (frame.kind === 'tool' && frame.toolCallId === toolCallId) {
            return { turnId: item.turnId, stepId: step.stepId, frame };
          }
        }
      }
    }
    return undefined;
  };

  const reducerFor = (agentId: string): TranscriptFactReducer => {
    let reducer = reducers.get(agentId);
    if (reducer === undefined) {
      reducer = new TranscriptFactReducer(store.ensureAgent(agentId));
      reducers.set(agentId, reducer);
    }
    return reducer;
  };

  const applyFacts = (agentId: string, facts: readonly TranscriptFact[]): void => {
    if (facts.length === 0) return;
    const result = reducerFor(agentId).apply(facts);
    if (result.gap !== undefined) {
      logger?.warn(
        { sessionId: store.sessionId, agentId, gap: result.gap },
        'transcript: append gap — producer/consumer skew',
      );
    }
    if (result.acceptedOperations.length > 0) {
      onOps?.({ agentId, ops: result.acceptedOperations });
    }
  };

  const applyOps = (agentId: string, ops: ReturnType<AgentTranscriptLiveAdapter['map']>): void => {
    if (ops.length === 0) return;
    applyFacts(agentId, [
      {
        factId: `transient:${agentId}:${++transientFactSeq}`,
        durability: 'transient',
        operations: ops,
      },
    ]);
  };

  const wireAdapterFor = (agentId: string): TranscriptWireAdapter => {
    let adapter = wireAdapters.get(agentId);
    if (adapter === undefined) {
      adapter = new TranscriptWireAdapter(agentId, {
        turn: (turnId) => store.getAgent(agentId)?.getTurn(turnId),
        tool: (toolCallId) => toolFrameFor(agentId, toolCallId),
        task: (taskId) => store.getAgent(agentId)?.getTask(taskId),
      });
      wireAdapters.set(agentId, adapter);
    }
    return adapter;
  };

  const liveAdapterFor = (agentId: string): AgentTranscriptLiveAdapter => {
    let liveAdapter = liveAdapters.get(agentId);
    if (liveAdapter === undefined) {
      liveAdapter = new AgentTranscriptLiveAdapter(agentId, {
        stepFrames: (turnId, stepId) =>
          store.getAgent(agentId)?.getTurn(turnId)?.steps.find((s) => s.stepId === stepId)?.frames,
        toolFrame: (toolCallId) => toolFrameFor(agentId, toolCallId),
        stepOrdinal: (turnId) => {
          const agentHandle = agents.get(agentId);
          if (agentHandle === undefined) return undefined;
          const view: IAgentActivityView | undefined = agentHandle.accessor.get(IAgentActivityView);
          const turn = view?.state().turn;
          return turn === undefined || `t${turn.turnId}` !== turnId ? undefined : turn.step;
        },
        turn: (turnId) => store.getAgent(agentId)?.getTurn(turnId),
        turnDetails: (turnId) => store.getAgent(agentId)?.getTurn(turnId),
        task: (taskId) => store.getAgent(agentId)?.getTask(taskId),
      });
      for (const agent of agents.list()) {
        if (agent.id !== agentId) continue;
        const tasks = agent.accessor.get(IAgentTaskService)?.list() ?? [];
        for (const info of tasks) {
          if (info.kind === 'agent' && typeof info.agentId === 'string' && info.agentId.length > 0) {
            applyOps(
              agentId,
              liveAdapter.seedSubagentTask({
                taskId: info.taskId,
                agentId: info.agentId,
                name: info.collaborationTaskName,
                subagentName: info.profile,
                description: info.description,
                status: info.status,
                detached: info.detached ?? false,
                startedAt: info.startedAt,
              }),
            );
          }
        }
      }
      liveAdapters.set(agentId, liveAdapter);
    }
    return liveAdapter;
  };

  const seedPrompts = (agentId?: string): void => {
    for (const agent of agents.list()) {
      if (agentId !== undefined && agent.id !== agentId) continue;
      const liveAdapter = liveAdapterFor(agent.id);
      let snapshot: ReturnType<IAgentPromptService['list']>;
      try {
        snapshot = agent.accessor.get(IAgentPromptService).list();
      } catch {
        continue;
      }
      const ops: ReturnType<AgentTranscriptLiveAdapter['seedPrompt']> = [];
      if (snapshot.active !== undefined) {
        ops.push(...liveAdapter.seedPrompt(promptFromSnapshot(snapshot.active, 'running')));
      }
      for (const pending of snapshot.pending) {
        ops.push(...liveAdapter.seedPrompt(promptFromSnapshot(pending, 'queued')));
      }
      applyOps(agent.id, ops);
    }
  };

  const seedRunningTasks = (agentId?: string): void => {
    for (const agent of agents.list()) {
      if (agentId !== undefined && agent.id !== agentId) continue;
      const liveAdapter = liveAdapterFor(agent.id);
      for (const info of agent.accessor.get(IAgentTaskService)?.list(true) ?? []) {
        if (info.kind !== 'agent' || info.agentId === undefined || info.agentId === '') continue;
        applyOps(
          agent.id,
          liveAdapter.seedSubagentTask({
            taskId: info.taskId,
            agentId: info.agentId,
            name: info.collaborationTaskName,
            subagentName: info.profile,
            description: info.description,
            status: info.status,
            detached: info.detached ?? false,
            startedAt: info.startedAt,
          }),
        );
      }
    }
  };

  const processEvent = (agentId: string, event: TranscriptWireRecord): void => {
    if (event.type === 'context.spliced') return;
    const liveOwned =
      event.type === 'subagent.spawned' ||
      event.type === 'subagent.started' ||
      event.type === 'subagent.completed' ||
      event.type === 'subagent.failed' ||
      event.type === 'subagent.suspended';
    if (!liveOwned) applyFacts(agentId, wireAdapterFor(agentId).add(event));
    if (
      event.type === 'task.started' ||
      event.type === 'task.terminated' ||
      event.type === 'tools.update_store' ||
      event.type === 'goal.create' ||
      event.type === 'goal.update' ||
      event.type === 'goal.clear' ||
      event.type === 'plan_mode.enter' ||
      event.type === 'plan_mode.exit' ||
      event.type === 'plan_mode.cancel' ||
      event.type === 'plan.revision' ||
      event.type === 'swarm_mode.enter' ||
      event.type === 'swarm_mode.exit' ||
      event.type === 'interaction.request' ||
      event.type === 'interaction.resolved' ||
      event.type === 'turn.cancel'
    ) {
      return;
    }
    applyOps(agentId, liveAdapterFor(agentId).map(event as unknown as LiveAdapterBusEvent));
  };

  const finishReplay = (agentId: string): void => {
    replayingAgents.delete(agentId);
    const buffered = bufferedEvents.get(agentId) ?? [];
    bufferedEvents.delete(agentId);
    for (const event of buffered) processEvent(agentId, event);
  };

  const subscribeAgent = (handle: IAgentScopeHandle, replay: boolean): void => {
    if (subscribedAgents.has(handle.id)) return;
    subscribedAgents.add(handle.id);
    if (replay) {
      replayingAgents.add(handle.id);
      bufferedEvents.set(handle.id, []);
    }
    liveAdapterFor(handle.id);
    store.ensureAgent(handle.id, { agentId: handle.id });
    const bus = handle.accessor.get(IEventBus);
    const busD = bus.subscribe((event) => {
      const record = event as unknown as TranscriptWireRecord;
      if (replayingAgents.has(handle.id)) {
        bufferedEvents.get(handle.id)?.push(record);
        return;
      }
      processEvent(handle.id, record);
    });
    const list = agentDisposables.get(handle.id) ?? [];
    list.push(busD);
    agentDisposables.set(handle.id, list);
  };

  const interactionAgentId = (interaction: Interaction): string => {
    const payloadAgent = (interaction.payload as { agentId?: unknown }).agentId;
    return (
      interaction.origin.agentId ??
      (typeof payloadAgent === 'string' ? payloadAgent : undefined) ??
      MAIN_AGENT_ID
    );
  };

  const announceInteraction = (interaction: Interaction): void => {
    if (interaction.kind !== 'approval' && interaction.kind !== 'question') return;
    const agentId = interactionAgentId(interaction);
    interactionAgents.set(interaction.id, agentId);
    const request: LiveAdapterInteraction = {
      id: interaction.id,
      kind: interaction.kind,
      payload: interaction.payload,
      origin: interaction.origin,
      createdAt: interaction.createdAt,
    };
    for (const target of agentId === MAIN_AGENT_ID ? [agentId] : [agentId, MAIN_AGENT_ID]) {
      applyOps(target, liveAdapterFor(target).mapInteractionRequested(request));
    }
  };

  const refreshDescriptors = (): void => {
    void session.accessor
      .get(ISessionMetadata)
      .read()
      .then((meta) => {
        for (const agentId of liveAdapters.keys()) {
          store.describeAgent(descriptorFromMeta(agentId, meta.agents?.[agentId]));
        }
      })
      .catch(() => {
      });
  };

  for (const handle of agents.list()) subscribeAgent(handle, bufferDuringReplay);
  disposables.push(
    agents.onDidCreate((handle) => {
      subscribeAgent(handle, false);
      seededAgents.add(handle.id);
      refreshDescriptors();
    }),
    agents.onDidDispose((agentId) => {
      for (const d of agentDisposables.get(agentId) ?? []) d.dispose();
      agentDisposables.delete(agentId);
      subscribedAgents.delete(agentId);
      liveAdapters.delete(agentId);
      reducers.delete(agentId);
      wireAdapters.delete(agentId);
      replayingAgents.delete(agentId);
      bufferedEvents.delete(agentId);
      store.markDisposed(agentId, new Date().toISOString());
    }),
  );

  for (const pending of interactions.listPending()) {
    if (pending.kind !== 'approval' && pending.kind !== 'question') continue;
    if (knownInteractions.has(pending.id)) continue;
    knownInteractions.add(pending.id);
    interactionAgents.set(pending.id, interactionAgentId(pending));
    unseeded.set(pending.id, pending);
  }
  const seedPendingInteractions = (agentId?: string): void => {
    if (agentId === undefined) seededAll = true;
    else seededAgents.add(agentId);
    for (const [id, interaction] of unseeded) {
      if (agentId !== undefined && interactionAgents.get(id) !== agentId) continue;
      unseeded.delete(id);
      announceInteraction(interaction);
      const early = earlyResolves.get(id);
      if (early === undefined) continue;
      interactionAgents.delete(id);
      earlyResolves.delete(id);
      for (const target of
        early.agentId === MAIN_AGENT_ID ? [early.agentId] : [early.agentId, MAIN_AGENT_ID]) {
        const liveAdapter = liveAdapters.get(target);
        if (liveAdapter !== undefined) {
          applyOps(target, liveAdapter.mapInteractionResolved(id, early.response));
        }
      }
    }
    for (const pending of interactions.listPending()) {
      if (knownInteractions.has(pending.id)) continue;
      if (agentId !== undefined && interactionAgentId(pending) !== agentId) continue;
      knownInteractions.add(pending.id);
      announceInteraction(pending);
    }
  };
  disposables.push(
    interactions.onDidChangePending(() => {
      for (const pending of interactions.listPending()) {
        if (knownInteractions.has(pending.id)) continue;
        const agentId = interactionAgentId(pending);
        knownInteractions.add(pending.id);
        if (!isSeeded(agentId)) {
          interactionAgents.set(pending.id, agentId);
          unseeded.set(pending.id, pending);
          continue;
        }
        announceInteraction(pending);
      }
    }),
    interactions.onDidResolve(({ id, response }) => {
      knownInteractions.delete(id);
      const agentId = interactionAgents.get(id);
      if (agentId === undefined) return;
      interactionAgents.delete(id);
      if (unseeded.has(id)) {
        earlyResolves.set(id, { agentId, response });
        return;
      }
      for (const target of agentId === MAIN_AGENT_ID ? [agentId] : [agentId, MAIN_AGENT_ID]) {
        const liveAdapter = liveAdapters.get(target);
        if (liveAdapter !== undefined) {
          applyOps(target, liveAdapter.mapInteractionResolved(id, response));
        }
      }
    }),
  );

  refreshDescriptors();

  return {
    seedPendingInteractions,
    seedRunningTasks,
    seedPrompts,
    finishReplay,
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const list of agentDisposables.values()) {
        for (const d of list) d.dispose();
      }
      agentDisposables.clear();
      liveAdapters.clear();
      reducers.clear();
      wireAdapters.clear();
      replayingAgents.clear();
      bufferedEvents.clear();
      interactionAgents.clear();
      knownInteractions.clear();
      unseeded.clear();
      earlyResolves.clear();
    },
  };
}

function promptFromSnapshot(
  snapshot: PromptSnapshot,
  status: Extract<TranscriptPrompt['status'], 'running' | 'queued'>,
): TranscriptPrompt {
  return {
    promptId: snapshot.id,
    status,
    userMessageId: snapshot.userMessageId,
    content: projectPromptContentParts(snapshot.message.content),
    createdAt: snapshot.createdAt,
  };
}

export function descriptorFromMeta(agentId: string, meta: AgentMeta | undefined): AgentDescriptor {
  const parentAgentId = subagentParentAgentId(meta);
  const delegator =
    meta?.delegator ??
    (parentAgentId === undefined ? undefined : { kind: 'agent' as const, agentId: parentAgentId });
  const userLabel = subagentUserLabel(meta);
  const type = meta?.type ?? (agentId === MAIN_AGENT_ID ? 'main' : 'sub');
  return {
    agentId,
    type,
    parentAgentId,
    delegator,
    label:
      type === 'sub'
        ? resolveSubagentDisplayName(userLabel, meta?.displayName, agentId)
        : undefined,
  };
}
