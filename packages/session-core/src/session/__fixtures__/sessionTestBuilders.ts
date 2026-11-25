import type { Session, SessionSnapshotResponse, SnapshotSubagent } from '@kiki/protocol';
import type { SessionViewFacade } from '@kiki/klient/session-view';
import type {
  ContentRef,
  TranscriptEvent,
  TranscriptFrame,
  TranscriptItem,
  TranscriptStep,
  TranscriptTask,
  TranscriptTaskRef,
  TranscriptTurn,
} from '@kiki/transcript';

import type { AgentTranscriptResponse } from '../../transport';
import type { SessionEventFrame } from '../../wire';
import type { SessionController } from '../sessionController';
import { FIXED_AT } from './canonicalTranscript';

export const TEST_SESSION: Session = {
  id: 'session_test',
  workspace_id: 'wd_test_000000000000',
  title: 'Test',
  created_at: FIXED_AT,
  updated_at: FIXED_AT,
  busy: false,
  metadata: { cwd: 'C:/tmp' },
  agent_config: { model: '' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  },
  permission_rules: [],
  message_count: 0,
  last_seq: 0,
};

export function testSession(overrides: Partial<Session> = {}): Session {
  return { ...TEST_SESSION, ...overrides };
}

export function snapshotResponse(
  overrides: Partial<SessionSnapshotResponse> = {},
): SessionSnapshotResponse {
  return {
    as_of_seq: 10,
    epoch: 'epoch-1',
    session: TEST_SESSION,
    messages: { items: [], has_more: false },
    in_flight_turn: null,
    pending_approvals: [],
    pending_questions: [],
    ...overrides,
  };
}

type TranscriptPageResult = Awaited<ReturnType<SessionViewFacade['transcript']['page']>>;

export function transcriptPage(
  agentId: string,
  items: readonly TranscriptItem[],
  overrides: Partial<TranscriptPageResult> = {},
): TranscriptPageResult {
  const hasMore = overrides.has_more ?? false;
  return {
    session_id: 'session_test',
    agent_id: agentId,
    items: [...items] as TranscriptPageResult['items'],
    has_more: hasMore,
    coverage: overrides.coverage
      ?? (hasMore ? { kind: 'tail', hasMoreOlder: true } : { kind: 'full', hasMoreOlder: false }),
    tasks: [],
    attachments: [],
    interactions: [],
    todos: [],
    prompts: [],
    meta: {},
    agents: [],
    pending_interactions: [],
    ...overrides,
  };
}

export function makeTurn(
  turnId: string,
  ordinal: number,
  overrides: Partial<TranscriptTurn> = {},
): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    ordinal,
    state: 'completed',
    origin: { kind: 'user' },
    steps: [],
    ...overrides,
  };
}

export function makeStep(
  stepId: string,
  turnId: string,
  ordinal: number,
  frames: readonly TranscriptFrame[] = [],
  overrides: Partial<TranscriptStep> = {},
): TranscriptStep {
  return {
    kind: 'step',
    stepId,
    turnId,
    ordinal,
    state: 'completed',
    frames: [...frames],
    ...overrides,
  };
}

export function textFrame(
  frameId: string,
  text: string,
  role: 'user' | 'assistant' = 'assistant',
  overrides: Partial<Extract<TranscriptFrame, { kind: 'text' }>> = {},
): Extract<TranscriptFrame, { kind: 'text' }> {
  return {
    kind: 'text',
    frameId,
    role,
    text,
    ...overrides,
  };
}

export function toolFrame(
  frameId: string,
  toolCallId: string,
  name: string,
  overrides: Partial<Extract<TranscriptFrame, { kind: 'tool' }>> = {},
): Extract<TranscriptFrame, { kind: 'tool' }> {
  return {
    kind: 'tool',
    frameId,
    toolCallId,
    name,
    state: 'done',
    ...overrides,
  };
}

export function subagentTask(
  taskId: string,
  agentId: string,
  overrides: Partial<TranscriptTask> = {},
): TranscriptTask {
  return {
    taskId,
    kind: 'subagent',
    state: 'running',
    detached: false,
    agentId,
    outputTail: '',
    startedAt: FIXED_AT,
    ...overrides,
  };
}

export function shellTaskItem(
  taskId: string,
  overrides: Partial<TranscriptTask> = {},
): TranscriptTask {
  return {
    taskId,
    kind: 'shell',
    state: 'completed',
    detached: false,
    outputTail: '',
    startedAt: FIXED_AT,
    ...overrides,
  };
}

export function taskRefItem(
  refId: string,
  taskId: string,
  at = FIXED_AT,
): TranscriptTaskRef {
  return { kind: 'taskref', refId, taskId, at };
}

export function compactSnapshotSubagent(
  overrides: Partial<SnapshotSubagent> & Pick<SnapshotSubagent, 'id'>,
): SnapshotSubagent {
  return {
    session_id: 'session_test',
    kind: 'subagent',
    description: 'Inspect the protocol',
    status: 'completed',
    created_at: FIXED_AT,
    ...overrides,
  };
}

export function contentRef(
  source: ContentRef['source'],
  overrides: Partial<Omit<ContentRef, 'source'>> = {},
): ContentRef {
  return {
    source,
    revision: 'r1',
    path: [],
    kind: 'text',
    offset: 0,
    total: 0,
    ...overrides,
  };
}

export function eventFrame(
  payload: SessionEventFrame['payload'],
  options: { seq?: number; volatile?: boolean; offset?: number } = {},
): SessionEventFrame {
  return {
    type: payload.type,
    seq: options.seq ?? 11,
    epoch: 'epoch-1',
    volatile: options.volatile,
    offset: options.offset,
    session_id: 'session_test',
    timestamp: '2026-01-01T00:00:01.000Z',
    payload,
  };
}

export function deliverFrame(controller: SessionController, frame: SessionEventFrame): void {
  if (frame.session_id !== controller.sessionId) return;
  if (frame.volatile === true) return;
  const cursor = { seq: frame.seq, epoch: frame.epoch };
  const payload = frame.payload as { type?: unknown; reason?: unknown; target_message_id?: unknown };
  if (
    payload.type === 'event.session.history_rewritten' &&
    (payload.reason === 'edit_resend' || payload.reason === 'regenerate') &&
    typeof payload.target_message_id === 'string'
  ) {
    controller.handleSignal({
      type: 'historyRewritten',
      cursor,
      generation: 0,
      reason: payload.reason,
      targetMessageId: payload.target_message_id,
    });
  } else {
    controller.handleSignal({ type: 'sessionCursorAdvanced', cursor, generation: 0 });
  }
}

export function deliverResync(
  controller: SessionController,
  payload: { session_id: string; reason: 'history_rewritten' | 'epoch_changed' | 'session_recreated' | 'buffer_overflow'; current_seq: number; epoch?: string },
): void {
  if (payload.session_id !== controller.sessionId) return;
  controller.handleSignal({ type: 'resyncRequired', generation: 0, reason: payload.reason, currentSessionCursor: { seq: payload.current_seq, epoch: payload.epoch } });
}

export function asTranscriptEvent(event: Record<string, unknown>): TranscriptEvent {
  const sessionId = typeof event['session_id'] === 'string' ? event['session_id'] : 'session_test';
  const seq = typeof event['seq'] === 'number' ? event['seq'] : 0;
  const cursor =
    event['cursor'] !== undefined && typeof event['cursor'] === 'object'
      ? (event['cursor'] as { seq: number; epoch?: string })
      : { seq, epoch: 'epoch-1' };
  if (event['type'] === 'transcript.reset') {
    const hasMoreOlder = event['has_more_older'] === true;
    return {
      type: 'transcript.reset',
      session_id: sessionId,
      agent_id: event['agent_id'],
      snapshot: event['snapshot'],
      grade: 'delta',
      coverage: hasMoreOlder ? { kind: 'tail', hasMoreOlder: true } : { kind: 'full', hasMoreOlder: false },
      cursor,
    } as TranscriptEvent;
  }
  return {
    type: 'transcript.ops',
    session_id: sessionId,
    agent_id: event['agent_id'],
    ops: event['ops'] ?? [],
    cursor,
    through_seq: event['through_seq'] ?? seq,
  } as TranscriptEvent;
}

export function fakeView(client: object, socket: object, sessionId = 'session_test'): SessionViewFacade {
  const reads = client as {
    snapshot(sessionId: string, options: { transcript: boolean }): Promise<SessionSnapshotResponse>;
    getAgentTranscript(sessionId: string, agentId: string, options: object): Promise<AgentTranscriptResponse>;
    getTranscriptOps(sessionId: string, agentId: string, since: object, grade?: string): ReturnType<SessionViewFacade['transcript']['catchUp']>;
  };
  const controls = socket as Record<string, (...args: unknown[]) => void>;
  return {
    snapshot: () => reads.snapshot(sessionId, { transcript: true }),
    transcript: {
      page: ({ agentId, ...options }) => reads.getAgentTranscript(sessionId, agentId, options) as ReturnType<SessionViewFacade['transcript']['page']>,
      catchUp: ({ agentId, since, grade }) => reads.getTranscriptOps(sessionId, agentId, since, grade) as ReturnType<SessionViewFacade['transcript']['catchUp']>,
    },
    subscribe: (input) => {
      controls['subscribe']?.(sessionId, input.sessionCursor, input.transcriptGrades);
      return {
        updateSessionCursor: (cursor) => { controls['updateCursor']?.(sessionId, cursor); },
        setTranscriptGrades: (grades) => { controls['setTranscriptGrades']?.(sessionId, grades); },
        updateTranscriptCursor: (agentId, cursor) => { controls['updateTranscriptSince']?.(sessionId, agentId, cursor); },
        restart: () => { controls['restartGeneration']?.(); },
        nudge: () => {},
        close: () => { controls['unsubscribe']?.(sessionId); },
      };
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function manualScheduler() {
  const pending: (() => void)[] = [];
  return {
    scheduler: {
      schedule(callback: () => void) {
        pending.push(callback);
        return pending.length;
      },
      cancel: () => {
        pending.length = 0;
      },
    },
    flushOne() {
      pending.shift()?.();
    },
    flushAll() {
      while (pending.length > 0) pending.shift()?.();
    },
  };
}
