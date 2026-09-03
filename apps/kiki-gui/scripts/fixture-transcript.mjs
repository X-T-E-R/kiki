/**
 * Fixture-side transcript projector. Turns the existing scenario `session_event`
 * steps into canonical `transcript.reset` / `transcript.ops` batches so the GUI
 * can attach with `subscribe_v2` without rewriting every scenario.
 *
 * Deterministic ids (no randomness):
 *   turn   t{turnId}
 *   step   t{turnId}.{step}
 *   text   asst-{turn}-{step}
 *   think  think-{turn}-{step}
 *   tool   tool-{toolCallId}
 */

export const EMPTY_SNAPSHOT = Object.freeze({
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
});

export const GRADE_RANK = Object.freeze({ off: 0, turn: 1, block: 2, delta: 3 });

export function gradeFor(spec, agentId) {
  if (spec === undefined || spec === null) return 'off';
  return spec[agentId] ?? spec['*'] ?? 'off';
}

export function filterOpsForGrade(grade, ops) {
  const rank = GRADE_RANK[grade] ?? 0;
  if (rank === 0) return [];
  return ops.filter((op) => {
    if (op.op === 'append') return rank >= GRADE_RANK.delta;
    if (op.op === 'step.upsert' || op.op === 'frame.upsert') return rank >= GRADE_RANK.block;
    return true;
  });
}

export function redactSnapshotForGrade(grade, snapshot) {
  const rank = GRADE_RANK[grade] ?? 0;
  if (rank === 0) return { ...EMPTY_SNAPSHOT };
  if (rank >= GRADE_RANK.block) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (item.kind === 'turn' ? { ...item, steps: [] } : item)),
  };
}

export function emptySnapshot() {
  return {
    items: [],
    tasks: [],
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: false,
  };
}

export function seedSnapshotEntities(projector, snapshot = {}) {
  const main = projector.ensure('main');
  for (const task of snapshot.tasks ?? []) {
    const state = task.status === 'cancelled' ? 'killed' : task.status;
    upsertList(main.snapshot.tasks, 'taskId', task.id, {
      taskId: task.id,
      kind:
        task.kind === 'bash'
          ? 'shell'
          : task.kind === 'subagent'
            ? 'subagent'
            : task.kind === 'tool'
              ? 'tool'
              : 'other',
      state,
      detached: task.run_in_background ?? true,
      description: task.description,
      agentId: task.agent_id,
      outputTail: task.output_preview ?? '',
      startedAt: task.started_at ?? task.created_at,
      endedAt: task.completed_at,
      stateReason: task.stop_reason,
    });
  }
  for (const approval of snapshot.pending_approvals ?? []) {
    upsertList(main.snapshot.interactions, 'interactionId', approval.approval_id, {
      interactionId: approval.approval_id,
      interactionKind: 'approval',
      toolCallId: approval.tool_call_id,
      origin: approval.agent_id === undefined ? undefined : { agentId: approval.agent_id },
      state: 'pending',
      request: {
        ...approval,
        turnId: approval.turn_id,
        toolCallId: approval.tool_call_id,
        toolName: approval.tool_name,
        display: approval.tool_input_display,
        createdAt: approval.created_at,
        expiresAt: approval.expires_at,
      },
    });
  }
  for (const question of snapshot.pending_questions ?? []) {
    upsertList(main.snapshot.interactions, 'interactionId', question.question_id, {
      interactionId: question.question_id,
      interactionKind: 'question',
      toolCallId: question.tool_call_id,
      origin: question.agent_id === undefined ? undefined : { agentId: question.agent_id },
      state: 'pending',
      request: {
        ...question,
        turnId: question.turn_id,
        toolCallId: question.tool_call_id,
        createdAt: question.created_at,
      },
    });
  }
}

function clone(value) {
  return structuredClone(value);
}

function asAgentId(frame) {
  return frame.agentId ?? frame.payload?.agentId ?? 'main';
}

function turnIdOf(payload) {
  const raw = payload.turnId ?? payload.turn_id ?? 1;
  return typeof raw === 'string' && raw.startsWith('t') ? raw : `t${raw}`;
}

function stepIdOf(turnId, step) {
  const ordinal = step ?? 1;
  return `${turnId}.${ordinal}`;
}

const CLOSED_TURN_ORIGIN_KINDS = new Set(['user', 'cron', 'task', 'hook', 'compaction', 'side', 'other']);

function originOf(payload, promptId, userMessageId) {
  const origin = payload.origin ?? { kind: 'user' };
  const kind = origin.kind;
  if (kind === 'user' || kind === undefined) {
    // Never fall back to promptId: regenerate issues a new prompt against the
    // existing journal user message, and those two ids are not interchangeable.
    const resolvedUserMessageId = payload.userMessageId ?? payload.user_message_id ?? userMessageId;
    const nextPayload = {
      ...(origin.payload !== undefined && typeof origin.payload === 'object' ? origin.payload : {}),
      ...(promptId !== undefined ? { promptId } : {}),
      ...(resolvedUserMessageId !== undefined ? { userMessageId: resolvedUserMessageId } : {}),
    };
    return { kind: 'user', payload: nextPayload };
  }
  if (CLOSED_TURN_ORIGIN_KINDS.has(kind)) {
    if (kind === 'task' && (typeof origin.taskId !== 'string' || origin.taskId === '')) {
      return { kind: 'other', payload: origin };
    }
    return origin;
  }
  if (kind === 'cron_job' || kind === 'cron_missed') return { kind: 'cron', payload: origin };
  if (kind === 'compaction_summary') return { kind: 'compaction', payload: origin };
  if (kind === 'hook_result') return { kind: 'hook', payload: origin };
  if (kind === 'task' || kind === 'background_task') {
    const taskId = origin.taskId;
    if (typeof taskId === 'string' && taskId !== '') return { kind: 'task', taskId, payload: origin };
    return { kind: 'other', payload: origin };
  }
  return { kind: 'other', payload: origin };
}

function findTurn(snapshot, turnId) {
  return snapshot.items.find((item) => item.kind === 'turn' && item.turnId === turnId);
}

function findStep(turn, stepId) {
  return turn?.steps?.find((step) => step.stepId === stepId);
}

function findFrame(step, frameId) {
  return step?.frames?.find((frame) => frame.frameId === frameId);
}

function upsertList(list, key, id, value) {
  const index = list.findIndex((entry) => entry[key] === id);
  if (index >= 0) {
    list[index] = { ...list[index], ...value };
    return;
  }
  list.push(value);
}

function applyOp(snapshot, op) {
  switch (op.op) {
    case 'reset':
      return clone(op.snapshot);
    case 'turn.upsert': {
      const existing = findTurn(snapshot, op.turn.turnId);
      if (existing === undefined) {
        snapshot.items.push({ ...op.turn, steps: op.turn.steps ?? [] });
      } else {
        Object.assign(existing, op.turn, { steps: existing.steps });
      }
      return snapshot;
    }
    case 'step.upsert': {
      const turn = findTurn(snapshot, op.turnId);
      if (turn === undefined) return snapshot;
      const existing = findStep(turn, op.step.stepId);
      if (existing === undefined) {
        turn.steps.push({ ...op.step, frames: op.step.frames ?? [] });
      } else {
        Object.assign(existing, op.step, { frames: existing.frames });
      }
      return snapshot;
    }
    case 'frame.upsert': {
      const turn = findTurn(snapshot, op.turnId);
      const step = findStep(turn, op.stepId);
      if (step === undefined) return snapshot;
      const existing = findFrame(step, op.frame.frameId);
      if (existing === undefined) step.frames.push(clone(op.frame));
      else Object.assign(existing, op.frame);
      return snapshot;
    }
    case 'append': {
      if (op.target.type !== 'frame') return snapshot;
      const turn = findTurn(snapshot, op.target.turnId);
      const step = findStep(turn, op.target.stepId);
      const frame = findFrame(step, op.target.frameId);
      if (frame === undefined) return snapshot;
      const field = frame.kind === 'tool' ? 'inputText' : 'text';
      const current = frame[field] ?? '';
      if (op.offset > current.length) return snapshot;
      frame[field] = current.slice(0, op.offset) + op.text;
      return snapshot;
    }
    case 'marker.upsert':
    case 'taskref.upsert': {
      const item = op.item;
      const id = item.kind === 'marker' ? item.markerId : item.refId;
      const index = snapshot.items.findIndex((entry) =>
        entry.kind === 'marker' ? entry.markerId === id : entry.kind === 'taskref' && entry.refId === id,
      );
      if (index >= 0) snapshot.items[index] = item;
      else snapshot.items.push(item);
      return snapshot;
    }
    case 'task.upsert':
      upsertList(snapshot.tasks, 'taskId', op.task.taskId, op.task);
      return snapshot;
    case 'interaction.upsert':
      upsertList(snapshot.interactions, 'interactionId', op.interaction.interactionId, op.interaction);
      return snapshot;
    case 'attachment.upsert':
      upsertList(snapshot.attachments, 'attachmentId', op.attachment.attachmentId, op.attachment);
      return snapshot;
    case 'todo.upsert':
      upsertList(snapshot.todos, 'todoId', op.todo.todoId, op.todo);
      return snapshot;
    case 'prompt.upsert':
      upsertList(snapshot.prompts, 'promptId', op.prompt.promptId, op.prompt);
      return snapshot;
    case 'meta.merge': {
      const next = { ...snapshot.meta };
      if (op.meta.goal === null) delete next.goal;
      else if (op.meta.goal !== undefined) next.goal = op.meta.goal;
      if (op.meta.modes !== undefined) {
        const modes = { ...(next.modes ?? {}) };
        if (op.meta.modes.plan === null) delete modes.plan;
        else if (op.meta.modes.plan !== undefined) modes.plan = op.meta.modes.plan;
        if (op.meta.modes.swarm === null) delete modes.swarm;
        else if (op.meta.modes.swarm !== undefined) modes.swarm = op.meta.modes.swarm;
        next.modes = modes;
      }
      if (op.meta.activity !== undefined) next.activity = op.meta.activity;
      if (op.meta.agent !== undefined) {
        next.agent = { ...(next.agent ?? {}), ...op.meta.agent };
      }
      snapshot.meta = next;
      return snapshot;
    }
    case 'items.remove': {
      const drop = new Set(op.ids);
      snapshot.items = snapshot.items.filter((item) => {
        const id = item.kind === 'turn' ? item.turnId : item.kind === 'marker' ? item.markerId : item.refId;
        return !drop.has(id);
      });
      return snapshot;
    }
    default:
      return snapshot;
  }
}

export function applyOps(snapshot, ops) {
  let next = snapshot;
  for (const op of ops) next = applyOp(next, op);
  return next;
}

function currentStep(agent) {
  const turn = findTurn(agent.snapshot, agent.live.turnId);
  if (turn === undefined) return undefined;
  return findStep(turn, agent.live.stepId) ?? turn.steps.at(-1);
}

function ensureLiveTurn(agent, payload, promptId, at) {
  const turnId = turnIdOf(payload);
  const stepOrdinal = payload.step ?? agent.live.stepOrdinal ?? 1;
  const stepId = stepIdOf(turnId, stepOrdinal);
  agent.live.turnId = turnId;
  agent.live.stepId = stepId;
  agent.live.stepOrdinal = stepOrdinal;
  const ops = [];
  if (findTurn(agent.snapshot, turnId) === undefined) {
    ops.push({
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: Number.parseInt(String(payload.turnId ?? 1), 10) || 1,
        state: 'running',
        origin: originOf(payload, promptId, agent.live.userMessageId),
        prompt: payload.prompt,
        startedAt: at,
        steps: [],
      },
    });
  }
  const turn = findTurn(applyOps(clone(agent.snapshot), ops), turnId);
  if (turn !== undefined && findStep(turn, stepId) === undefined) {
    ops.push({
      op: 'step.upsert',
      turnId,
      step: {
        kind: 'step',
        stepId,
        turnId,
        ordinal: stepOrdinal,
        state: 'running',
        frames: [],
        startedAt: at,
      },
    });
  }
  return { turnId, stepId, ops };
}

function textFrameId(kind, turnId, stepId) {
  return kind === 'thinking' ? `think-${turnId}-${stepId}` : `asst-${turnId}-${stepId}`;
}

function assistantPart(agent, turnId, frameId) {
  const messageId = agent.live.assistantMessageId ?? `${agent.agentId}-${turnId}-asst`;
  agent.live.assistantMessageId = messageId;
  return {
    partId: `part-${frameId}`,
    messageId,
    revision: 1,
    provenance: { source: 'engine' },
  };
}

function deltaOps(agent, kind, payload, offset, at) {
  const promptId = agent.live.promptId;
  const ensured = ensureLiveTurn(agent, payload, promptId, at);
  const frameId = textFrameId(kind, ensured.turnId, ensured.stepId);
  const step = currentStep({ ...agent, snapshot: applyOps(clone(agent.snapshot), ensured.ops), live: { ...agent.live, ...ensured } });
  const existing = findFrame(step, frameId);
  const ops = [...ensured.ops];
  const delta = payload.delta ?? payload.text ?? '';
  const local = existing?.text ?? '';
  // Scenario streamSteps offsets are per-segment. A later segment of the same
  // live frame must append after the already-projected text, never rewind to 0
  // and overwrite Segment A with Segment B.
  const atOffset = existing === undefined
    ? (offset ?? 0)
    : Math.max(local.length, offset ?? 0);
  if (existing === undefined) {
    const identity = assistantPart(agent, ensured.turnId, frameId);
    const frame =
      kind === 'thinking'
        ? { kind: 'thinking', frameId, text: atOffset === 0 ? delta : '' }
        : { kind: 'text', frameId, role: 'assistant', text: atOffset === 0 ? delta : '', part: identity };
    ops.push({ op: 'frame.upsert', turnId: ensured.turnId, stepId: ensured.stepId, frame });
    if (atOffset > 0 && delta !== '') {
      ops.push({
        op: 'append',
        target: { type: 'frame', turnId: ensured.turnId, stepId: ensured.stepId, frameId },
        offset: atOffset,
        text: delta,
      });
    }
  } else {
    ops.push({
      op: 'append',
      target: { type: 'frame', turnId: ensured.turnId, stepId: ensured.stepId, frameId },
      offset: atOffset,
      text: delta,
    });
  }
  ops.push({
    op: 'meta.merge',
    meta: {
      activity: 'turn',
      agent: {
        phase: {
          kind: 'streaming',
          turnId: Number.parseInt(String(payload.turnId ?? 1), 10) || 1,
          step: agent.live.stepOrdinal ?? 1,
          stepId: ensured.stepId,
          stream: kind === 'thinking' ? 'thinking' : 'assistant',
          since: 0,
        },
      },
    },
  });
  return { agentId: agent.agentId, ops };
}

export class TranscriptProjector {
  constructor(sessionId, seed = {}, epoch = 'ep_fixture_1') {
    this.sessionId = sessionId;
    this.epoch = epoch;
    this.agents = new Map();
    this.activePromptId = undefined;
    for (const [agentId, snapshot] of Object.entries(seed)) {
      this.ensure(agentId, snapshot);
    }
    this.ensure('main', seed.main);
  }

  ensure(agentId, seedSnapshot) {
    const existing = this.agents.get(agentId);
    if (existing !== undefined) return existing;
    const snapshot = seedSnapshot === undefined
      ? emptySnapshot()
      : {
          items: [...(seedSnapshot.items ?? [])],
          tasks: [...(seedSnapshot.tasks ?? [])],
          interactions: [...(seedSnapshot.interactions ?? [])],
          attachments: [...(seedSnapshot.attachments ?? [])],
          todos: [...(seedSnapshot.todos ?? [])],
          prompts: [...(seedSnapshot.prompts ?? [])],
          meta: { ...(seedSnapshot.meta ?? {}) },
          hasMoreOlder: seedSnapshot.has_more === true || seedSnapshot.hasMoreOlder === true,
        };
    const agent = {
      agentId,
      snapshot,
      seq: seedSnapshot?.seq ?? 0,
      journal: [],
      live: { turnId: undefined, stepId: undefined, stepOrdinal: 1, promptId: undefined, userMessageId: undefined, assistantMessageId: undefined },
    };
    this.agents.set(agentId, agent);
    return agent;
  }

  snapshot(agentId) {
    return clone(this.ensure(agentId).snapshot);
  }

  latestSeq(agentId) {
    return this.ensure(agentId).seq;
  }

  bindAssistantMessageId(agentId, messageId) {
    const agent = this.ensure(agentId);
    agent.live.assistantMessageId = messageId;
    const turn = findTurn(agent.snapshot, agent.live.turnId);
    const step = findStep(turn, agent.live.stepId) ?? turn?.steps?.at(-1);
    const frame = step?.frames?.find((entry) => entry.kind === 'text' && entry.role === 'assistant');
    if (frame === undefined || turn === undefined || step === undefined) return undefined;
    frame.part = {
      ...(frame.part ?? {}),
      partId: frame.part?.partId ?? `part-${frame.frameId}`,
      messageId,
      revision: frame.part?.revision ?? 1,
      provenance: frame.part?.provenance ?? { source: 'engine' },
    };
    return this.commit(agentId, [
      {
        op: 'frame.upsert',
        turnId: turn.turnId,
        stepId: step.stepId,
        frame: clone(frame),
      },
    ]);
  }

  catchup(agentId, since) {
    const agent = this.ensure(agentId);
    const batches = agent.journal.filter((entry) => entry.seq > since);
    const complete = since <= 0 || agent.journal.some((entry) => entry.seq === since) || since >= agent.seq;
    return {
      session_id: this.sessionId,
      agent_id: agentId,
      epoch: this.epoch,
      batches,
      through_seq: agent.seq,
      complete,
    };
  }

  commit(agentId, ops) {
    if (ops.length === 0) return undefined;
    const agent = this.ensure(agentId);
    agent.seq += 1;
    agent.snapshot = applyOps(agent.snapshot, ops);
    const batch = { seq: agent.seq, ops };
    agent.journal.push(batch);
    if (agent.journal.length > 1000) agent.journal.splice(0, agent.journal.length - 1000);
    return { agentId, seq: agent.seq, ops };
  }

  skipSeq(agentId, count = 1) {
    const agent = this.ensure(agentId);
    agent.seq += count;
    return agent.seq;
  }

  ingestFrame(frame, extras = {}) {
    const type = frame.type;
    const payload = frame.payload ?? {};
    const agentId = asAgentId(frame);
    const at = extras.at ?? payload.created_at ?? payload.startedAt ?? new Date().toISOString();
    const promptId = extras.promptId ?? payload.promptId ?? payload.prompt_id;
    const agent = this.ensure(agentId);
    const batches = [];
    const push = (next) => {
      if (next === undefined) return;
      batches.push(next);
    };
    let projected;

    switch (type) {
      case 'turn.started': {
        const turnId = turnIdOf(payload);
        const stepId = stepIdOf(turnId, 1);
        agent.live = {
          turnId,
          stepId,
          stepOrdinal: 1,
          promptId,
          userMessageId: extras.userMessageId,
          assistantMessageId: undefined,
        };
        const ops = [
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId,
              ordinal: Number.parseInt(String(payload.turnId ?? 1), 10) || 1,
              state: 'running',
              origin: originOf(payload, promptId, extras.userMessageId),
              prompt: payload.prompt,
              startedAt: at,
              steps: [],
            },
          },
          {
            op: 'step.upsert',
            turnId,
            step: { kind: 'step', stepId, turnId, ordinal: 1, state: 'running', frames: [], startedAt: at },
          },
          {
            op: 'meta.merge',
            meta: {
              activity: 'turn',
              agent: {
                phase: {
                  kind: 'running',
                  turnId: Number.parseInt(String(payload.turnId ?? 1), 10) || 1,
                  step: 1,
                  stepId,
                  since: 0,
                },
              },
            },
          },
        ];
        if (promptId !== undefined) {
          ops.push({
            op: 'prompt.upsert',
            prompt: {
              promptId,
              status: 'running',
              userMessageId: extras.userMessageId ?? promptId,
              content: payload.prompt === undefined ? extras.content : [{ type: 'text', text: payload.prompt }],
              createdAt: at,
            },
          });
          this.activePromptId = promptId;
        }
        projected = { agentId, ops };
        break;
      }
      case 'turn.step.started': {
        const turnId = turnIdOf(payload);
        const stepId = stepIdOf(turnId, payload.step ?? 1);
        agent.live.turnId = turnId;
        agent.live.stepId = stepId;
        agent.live.stepOrdinal = payload.step ?? 1;
        projected = {
          agentId,
          ops: [
            {
              op: 'step.upsert',
              turnId,
              step: {
                kind: 'step',
                stepId,
                turnId,
                ordinal: payload.step ?? 1,
                state: 'running',
                frames: [],
                startedAt: at,
              },
            },
          ],
        };
        break;
      }
      case 'turn.step.completed': {
        const turnId = turnIdOf(payload);
        const stepId = stepIdOf(turnId, payload.step ?? agent.live.stepOrdinal ?? 1);
        const existingStep = findStep(findTurn(agent.snapshot, turnId), stepId);
        projected = {
          agentId,
          ops: [
            {
              op: 'step.upsert',
              turnId,
              step: {
                kind: 'step',
                stepId,
                turnId,
                ordinal: payload.step ?? 1,
                state: 'completed',
                startedAt: existingStep?.startedAt,
                endedAt: at,
                usage: payload.usage ?? existingStep?.usage,
                timing: payload.timing ?? existingStep?.timing,
                finishReason: payload.finishReason ?? existingStep?.finishReason,
              },
            },
          ],
        };
        break;
      }
      case 'turn.ended': {
        const turnId = turnIdOf(payload);
        const existing = findTurn(agent.snapshot, turnId);
        const state =
          payload.reason === 'cancelled' ? 'cancelled' : payload.reason === 'failed' ? 'failed' : 'completed';
        const ops = [];
        for (const step of existing?.steps ?? []) {
          for (const frame of step.frames) {
            if (frame.kind !== 'tool' || frame.state !== 'running') continue;
            ops.push({
              op: 'frame.upsert',
              turnId,
              stepId: step.stepId,
              frame: { ...frame, state: 'interrupted', endedAt: at },
            });
          }
          if (step.state === 'running') {
            ops.push({
              op: 'step.upsert',
              turnId,
              step: { ...step, state: 'interrupted', endedAt: at },
            });
          }
        }
        ops.push(
          {
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId,
              ordinal: existing?.ordinal ?? (Number.parseInt(String(payload.turnId ?? 1), 10) || 1),
              state,
              origin: existing?.origin ?? originOf(payload, agent.live.promptId, agent.live.userMessageId),
              message: existing?.message,
              prompt: existing?.prompt,
              attachmentIds: existing?.attachmentIds,
              startedAt: existing?.startedAt,
              endedAt: at,
              durationMs: payload.durationMs,
              usage: payload.usage,
              error: payload.error?.message ?? payload.error,
            },
          },
          {
            op: 'meta.merge',
            meta: {
              activity: 'idle',
              agent: {
                phase: {
                  kind: 'ended',
                  turnId: Number.parseInt(String(payload.turnId ?? 1), 10) || 1,
                  reason: payload.reason ?? 'completed',
                  durationMs: payload.durationMs,
                  at: 0,
                },
              },
            },
          },
        );
        projected = { agentId, ops };
        break;
      }
      case 'assistant.delta':
        projected = deltaOps(agent, 'assistant', payload, frame.offset, at);
        break;
      case 'thinking.delta':
        projected = deltaOps(agent, 'thinking', payload, frame.offset, at);
        break;
      case 'tool.call.started': {
        const ensured = ensureLiveTurn(agent, payload, agent.live.promptId, at);
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        const frameId = `tool-${toolCallId}`;
        const agentRefs =
          payload.name === 'Agent' && payload.subagentId !== undefined
            ? [{ agentId: payload.subagentId, role: 'child' }]
            : payload.agentRefs;
        projected = {
          agentId,
          ops: [
            ...ensured.ops,
            {
              op: 'frame.upsert',
              turnId: ensured.turnId,
              stepId: ensured.stepId,
              frame: {
                kind: 'tool',
                frameId,
                toolCallId,
                name: payload.name,
                state: 'running',
                input: payload.args ?? payload.input,
                display: payload.display,
                inputText: typeof payload.args === 'string' ? payload.args : undefined,
                agentRefs,
              },
            },
          ],
        };
        break;
      }
      case 'tool.call.delta': {
        const toolCallId = payload.toolCallId ?? payload.tool_call_id ?? 'burst-call';
        const ensured = ensureLiveTurn(agent, payload, agent.live.promptId, at);
        const turnId = ensured.turnId;
        const stepId = ensured.stepId;
        const frameId = `tool-${toolCallId}`;
        const staged = applyOps(clone(agent.snapshot), ensured.ops);
        const existing = findFrame(findStep(findTurn(staged, turnId), stepId), frameId);
        const ops = [...ensured.ops];
        if (existing === undefined) {
          ops.push({
            op: 'frame.upsert',
            turnId,
            stepId,
            frame: {
              kind: 'tool',
              frameId,
              toolCallId,
              name: payload.name ?? 'Write',
              state: 'running',
              inputText: payload.argumentsPart ?? payload.delta ?? '',
            },
          });
        } else {
          ops.push({
            op: 'append',
            target: { type: 'frame', turnId, stepId, frameId },
            offset: (existing.inputText ?? '').length,
            text: payload.argumentsPart ?? payload.delta ?? '',
          });
        }
        projected = { agentId, ops };
        break;
      }
      case 'tool.progress': {
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        const turnId = agent.live.turnId ?? turnIdOf(payload);
        const stepId = agent.live.stepId ?? stepIdOf(turnId, 1);
        projected = {
          agentId,
          ops: [
            {
              op: 'frame.upsert',
              turnId,
              stepId,
              frame: {
                kind: 'tool',
                frameId: `tool-${toolCallId}`,
                toolCallId,
                name: payload.name ?? 'tool',
                state: 'running',
                progress: payload.update ?? payload.progress,
              },
            },
          ],
        };
        break;
      }
      case 'tool.result': {
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        const turnId = agent.live.turnId ?? turnIdOf(payload);
        const stepId = agent.live.stepId ?? stepIdOf(turnId, 1);
        const isError = payload.is_error === true || payload.isError === true;
        projected = {
          agentId,
          ops: [
            {
              op: 'frame.upsert',
              turnId,
              stepId,
              frame: {
                kind: 'tool',
                frameId: `tool-${toolCallId}`,
                toolCallId,
                name: payload.name ?? 'tool',
                state: isError ? 'error' : 'done',
                output: payload.output,
                error: isError ? String(payload.output ?? 'error') : undefined,
              },
            },
          ],
        };
        break;
      }
      case 'prompt.submitted':
      case 'prompt.queued':
      case 'prompt.completed':
      case 'prompt.aborted': {
        const id = payload.promptId ?? payload.prompt_id ?? promptId;
        if (id === undefined) break;
        const status =
          type === 'prompt.completed'
            ? 'completed'
            : type === 'prompt.aborted'
              ? 'aborted'
              : type === 'prompt.queued'
                ? 'queued'
                : 'running';
        projected = {
          agentId,
          ops: [
            {
              op: 'prompt.upsert',
              prompt: {
                promptId: id,
                status,
                userMessageId: payload.userMessageId ?? payload.user_message_id ?? extras.userMessageId,
                content: payload.content ?? extras.content,
                createdAt: payload.createdAt ?? at,
                finishedAt: payload.finishedAt,
                steeredAt: payload.steeredAt,
              },
            },
          ],
        };
        break;
      }
      case 'prompt.steered': {
        // Wire names parked prompts in `promptIds` and the running turn in
        // `activePromptId`. extras.promptId is the running prompt (fanout merges
        // the active item) and must not become the steered identity.
        const steeredIds = [
          ...(Array.isArray(payload.promptIds) ? payload.promptIds : []),
          ...(Array.isArray(payload.prompt_ids) ? payload.prompt_ids : []),
        ].filter((id, index, all) => typeof id === 'string' && id !== '' && all.indexOf(id) === index);
        const findPrompt = (id) => agent.snapshot.prompts.find((entry) => entry.promptId === id);
        const steeredAt = payload.steeredAt ?? at;
        const ops = steeredIds.map((id) => {
          const prev = findPrompt(id);
          return {
            op: 'prompt.upsert',
            prompt: {
              promptId: id,
              status: 'completed',
              ...(prev?.userMessageId !== undefined ? { userMessageId: prev.userMessageId } : {}),
              content: prev?.content ?? payload.content,
              createdAt: prev?.createdAt ?? steeredAt,
              finishedAt: steeredAt,
              steeredAt,
            },
          };
        });
        projected = { agentId, ops };
        break;
      }
      case 'event.approval.requested': {
        projected = {
          agentId,
          ops: [
            {
              op: 'interaction.upsert',
              interaction: {
                interactionId: payload.approval_id,
                interactionKind: 'approval',
                toolCallId: payload.tool_call_id,
                origin: { agentId },
                state: 'pending',
                request: {
                  turnId: payload.turn_id,
                  toolName: payload.tool_name,
                  action: payload.action,
                  display: payload.tool_input_display,
                  createdAt: payload.created_at,
                  expiresAt: payload.expires_at,
                },
              },
            },
          ],
        };
        break;
      }
      case 'event.approval.resolved': {
        projected = {
          agentId,
          ops: [
            {
              op: 'interaction.upsert',
              interaction: {
                interactionId: payload.approval_id,
                interactionKind: 'approval',
                toolCallId: payload.tool_call_id,
                state: payload.decision === 'rejected' ? 'rejected' : 'approved',
                response: { decision: payload.decision, resolvedAt: payload.resolved_at },
              },
            },
          ],
        };
        break;
      }
      case 'event.question.requested': {
        projected = {
          agentId,
          ops: [
            {
              op: 'interaction.upsert',
              interaction: {
                interactionId: payload.question_id,
                interactionKind: 'question',
                toolCallId: payload.tool_call_id,
                origin: { agentId },
                state: 'pending',
                request: {
                  turnId: payload.turn_id,
                  questions: payload.questions,
                  createdAt: payload.created_at,
                },
              },
            },
          ],
        };
        break;
      }
      case 'event.question.answered':
      case 'event.question.dismissed': {
        projected = {
          agentId,
          ops: [
            {
              op: 'interaction.upsert',
              interaction: {
                interactionId: payload.question_id,
                interactionKind: 'question',
                state: type === 'event.question.answered' ? 'answered' : 'dismissed',
                response: payload,
              },
            },
          ],
        };
        break;
      }
      case 'subagent.spawned': {
        const parent = this.ensure('main');
        const spawnTurn = parent.live.turnId ?? 't1';
        const spawnStep = parent.live.stepId ?? stepIdOf(spawnTurn, 1);
        const toolCallId = payload.parentToolCallId ?? `call-${payload.subagentId}`;
        const taskId = payload.taskId ?? `task-${payload.subagentId}`;
        const parentOps = [];
        if (findTurn(parent.snapshot, spawnTurn) === undefined) {
          parentOps.push({
            op: 'turn.upsert',
            turn: {
              kind: 'turn',
              turnId: spawnTurn,
              ordinal: 1,
              state: 'running',
              origin: { kind: 'user' },
              steps: [],
            },
          });
        }
        const spawnTurnNow = findTurn(applyOps(clone(parent.snapshot), parentOps), spawnTurn);
        if (spawnTurnNow !== undefined && findStep(spawnTurnNow, spawnStep) === undefined) {
          parentOps.push({
            op: 'step.upsert',
            turnId: spawnTurn,
            step: { kind: 'step', stepId: spawnStep, turnId: spawnTurn, ordinal: 1, state: 'running', frames: [], startedAt: at },
          });
        }
        parentOps.push(
          {
            op: 'frame.upsert',
            turnId: spawnTurn,
            stepId: spawnStep,
            frame: {
              kind: 'tool',
              frameId: `tool-${toolCallId}`,
              toolCallId,
              name: 'Agent',
              state: 'running',
              input: { description: payload.description, subagentType: payload.subagentName },
              agentRefs: [{ agentId: payload.subagentId, role: 'child' }],
            },
          },
          {
            op: 'task.upsert',
            task: {
              taskId,
              kind: 'subagent',
              state: 'running',
              detached: payload.runInBackground === true,
              name: payload.name,
              subagentName: payload.subagentName,
              description: payload.description ?? payload.subagentName,
              agentId: payload.subagentId,
              outputTail: '',
              startedAt: at,
            },
          },
          {
            op: 'taskref.upsert',
            item: { kind: 'taskref', refId: `ref-${taskId}`, taskId, at },
          },
        );
        push(this.commit('main', parentOps));
        this.ensure(payload.subagentId);
        push(this.commit(payload.subagentId, [
          {
            op: 'meta.merge',
            meta: {
              agent: {
                model: payload.model,
                thinkingEffort: payload.thinkingEffort,
                phase: { kind: 'running', turnId: 1, step: 1, stepId: 't1.1', since: 0 },
              },
            },
          },
        ]));
        return batches;
      }
      case 'subagent.started': {
        projected = {
          agentId: payload.subagentId ?? agentId,
          ops: [
            {
              op: 'meta.merge',
              meta: { agent: { phase: { kind: 'running', turnId: 1, step: 1, stepId: 't1.1', since: 0 } } },
            },
          ],
        };
        break;
      }
      case 'subagent.completed':
      case 'subagent.failed': {
        const childId = payload.subagentId ?? agentId;
        const state =
          type === 'subagent.completed'
            ? 'completed'
            : payload.error === 'terminated'
              ? 'killed'
              : 'failed';
        const main = this.ensure('main');
        const taskId =
          payload.taskId ??
          main.snapshot.tasks.find((task) => task.agentId === childId && task.state === 'running')?.taskId ??
          `task-${childId}`;
        const previous = main.snapshot.tasks.find((task) => task.taskId === taskId);
        push(this.commit('main', [
          {
            op: 'task.upsert',
            task: {
              ...previous,
              taskId,
              kind: 'subagent',
              state,
              detached: previous?.detached ?? false,
              name: previous?.name,
              subagentName: previous?.subagentName,
              description: payload.description ?? previous?.description,
              agentId: childId,
              outputTail: payload.output ?? payload.resultSummary ?? previous?.outputTail ?? '',
              resultSummary: payload.output ?? payload.resultSummary ?? previous?.resultSummary,
              error: state === 'failed' ? payload.error : undefined,
              stateReason: payload.reason ?? payload.error ?? previous?.stateReason,
              startedAt: previous?.startedAt,
              endedAt: at,
              usage: payload.usage ?? previous?.usage,
            },
          },
        ]));
        projected = {
          agentId: childId,
          ops: [
            {
              op: 'meta.merge',
              meta: {
                agent: {
                  phase: {
                    kind: 'ended',
                    turnId: 1,
                    reason: state === 'failed' ? 'failed' : state === 'killed' ? 'cancelled' : 'completed',
                    at: 0,
                  },
                },
              },
            },
          ],
        };
        break;
      }
      case 'agent.status.updated': {
        projected = {
          agentId,
          ops: [
            {
              op: 'meta.merge',
              meta: {
                agent: {
                  model: payload.model,
                  thinkingEffort: payload.thinkingEffort,
                  permission: payload.permission,
                  contextTokens: payload.contextTokens,
                  maxContextTokens: payload.maxContextTokens,
                  usage: payload.usage,
                  phase: payload.phase,
                },
                modes: {
                  plan: payload.planMode === true ? {} : payload.planMode === false ? null : undefined,
                  swarm: payload.swarmMode === true ? {} : payload.swarmMode === false ? null : undefined,
                },
              },
            },
          ],
        };
        break;
      }
      case 'goal.updated': {
        projected = {
          agentId: 'main',
          ops: [{ op: 'meta.merge', meta: { goal: payload.snapshot ?? null } }],
        };
        break;
      }
      case 'event.session.history_rewritten': {
        // Truncate the live snapshot in place and do not journal items.remove.
        // Rewrite HTTP handlers reseed + startPrompt + fanoutTranscriptReset;
        // a committed remove creates a seq hole so the next prompt.submitted
        // catch-up replays the wipe before the reset, dropping the previous
        // settled journal user the GUI regenerate stamp needs.
        const agent = this.ensure('main');
        agent.snapshot.items = [];
        agent.snapshot.prompts = [];
        agent.live = {
          turnId: undefined,
          stepId: undefined,
          stepOrdinal: 1,
          promptId: extras.promptId,
          userMessageId: extras.userMessageId,
          assistantMessageId: undefined,
        };
        return [];
      }
      default:
        return batches;
    }

    if (projected !== undefined && projected.ops.length > 0) {
      push(this.commit(projected.agentId, projected.ops));
      if (projected.agentId !== 'main') {
        const interactions = projected.ops.filter((op) => op.op === 'interaction.upsert');
        if (interactions.length > 0) push(this.commit('main', interactions));
      }
    }
    return batches;
  }

  resetEvent(agentId, grade = 'delta') {
    const agent = this.ensure(agentId);
    const hasMore = agent.snapshot.hasMoreOlder === true;
    return {
      type: 'transcript.reset',
      session_id: this.sessionId,
      agent_id: agentId,
      snapshot: clone(agent.snapshot),
      grade,
      coverage: hasMore ? { kind: 'tail', hasMoreOlder: true } : { kind: 'full', hasMoreOlder: false },
      cursor: { seq: agent.seq, epoch: this.epoch },
      seq: agent.seq,
      has_more_older: hasMore,
    };
  }

  opsEvent(agentId, batch) {
    return {
      type: 'transcript.ops',
      session_id: this.sessionId,
      agent_id: agentId,
      ops: batch.ops,
      cursor: { seq: batch.seq, epoch: this.epoch },
      through_seq: batch.seq,
      seq: batch.seq,
    };
  }
}

export function transcriptEnvelope(sessionId, payload, seq, epoch) {
  return {
    type: payload.type,
    seq,
    epoch,
    volatile: true,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function textOfMessage(message) {
  return (message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Fold journaled snapshot messages into canonical turns so a transcript-mode
 * attach has the same settled history the legacy snapshot page showed.
 */
export function seedMessages(projector, messages, options = {}) {
  const older = options.older ?? [];
  const window = messages ?? [];
  const olderTurnCount = older.filter((message) => message.role === 'user').length;
  let ordinal = olderTurnCount;
  const agent = projector.ensure('main');
  agent.snapshot.items = [];
  agent.snapshot.hasMoreOlder = options.hasMore === true || older.length > 0;

  let current = null;
  const flush = () => {
    if (current === undefined || current === null) return;
    agent.snapshot.items.push(current);
    current = null;
  };

  for (const message of window) {
    if (message.role === 'user') {
      flush();
      ordinal += 1;
      const turnId = `t${ordinal}`;
      const prompt = textOfMessage(message);
      current = {
        kind: 'turn',
        turnId,
        ordinal,
        state: 'completed',
        origin: originOf(
          { origin: message.metadata?.origin },
          message.prompt_id ?? message.id,
          message.id,
        ),
        prompt,
        startedAt: message.created_at,
        endedAt: message.created_at,
        steps: [
          {
            kind: 'step',
            stepId: `${turnId}.1`,
            turnId,
            ordinal: 1,
            state: 'completed',
            frames: [],
            startedAt: message.created_at,
            endedAt: message.created_at,
          },
        ],
      };
      continue;
    }
    if (current === null) continue;
    const step = current.steps[0];
    if (message.role === 'assistant') {
      for (const [index, part] of (message.content ?? []).entries()) {
        if (part.type === 'text') {
          step.frames.push({
            kind: 'text',
            frameId: `asst-${current.turnId}-${index}`,
            role: 'assistant',
            text: part.text,
            part: {
              partId: `part-asst-${current.turnId}-${index}`,
              messageId: message.id,
              revision: 1,
              provenance: { source: 'engine' },
            },
          });
        } else if (part.type === 'thinking') {
          step.frames.push({
            kind: 'thinking',
            frameId: `think-${current.turnId}-${index}`,
            text: part.thinking,
          });
        } else if (part.type === 'tool_use') {
          step.frames.push({
            kind: 'tool',
            frameId: `tool-${part.tool_call_id}`,
            toolCallId: part.tool_call_id,
            name: part.tool_name,
            state: 'done',
            input: part.input,
          });
        }
      }
    } else if (message.role === 'tool') {
      for (const part of message.content ?? []) {
        if (part.type !== 'tool_result') continue;
        const existing = step.frames.find(
          (frame) => frame.kind === 'tool' && frame.toolCallId === part.tool_call_id,
        );
        if (existing !== undefined) {
          existing.output = part.output;
          existing.state = part.is_error === true ? 'error' : 'done';
        }
      }
    }
  }
  flush();
  agent.seq = Math.max(agent.seq, ordinal);
}
