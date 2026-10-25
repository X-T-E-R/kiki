import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_dispatch_descendant_fold';

const HOUR = 3600_000;
const BASE = Date.parse('2026-01-01T09:00:00.000Z');
const at = (offsetMs) => new Date(BASE + offsetMs).toISOString();

// The counterexample the fold rule exists for. `agent-lead` is BORN at T10 and
// already owns `agent-old`, born at T20. The dispatch this card represents is a
// LATER run of lead, from T40; `agent-new` is born at T60, inside that window.
const LEAD_BIRTH = at(10 * 60_000);
const OLD_BIRTH = at(20 * 60_000);
const DISPATCH_START = at(40 * 60_000);
const NEW_BIRTH = at(60 * 60_000);
// `agent-old` is running AGAIN, resumed at T50 — after the dispatch — and it
// must still fold: a resume moves a run start, never a birth.
const OLD_RESUME = at(50 * 60_000);

const tool = (id, agentId, startedAt) => ({
  kind: 'tool', frameId: `tool-${id}`, toolCallId: id, name: 'AgentRun',
  state: 'done', input: { profile: 'explore', description: 'Subtask', prompt: 'Do the bounded work and report.' },
  output: `task_id: task-${agentId}\nagent_id: ${agentId}\nactual_profile: explore\nstatus: running\n`,
  startedAt, endedAt: at(70 * 60_000), agentRefs: [{ agentId, role: 'child' }],
});
const turn = (frames, startedAt = DISPATCH_START) => ({
  kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' },
  prompt: '核对派遣轮次与后代归属。', startedAt, endedAt: undefined,
  steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running', startedAt, endedAt: undefined, frames }],
});
const task = (agentId, name, state, startedAt, endedAt) => ({
  taskId: `task-${agentId}`, kind: 'subagent', state, detached: false, agentId, name, subagentName: name,
  description: name, startedAt, endedAt, outputTail: '',
});

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: dispatch descendant fold' })],
  snapshots: {
    [SID]: {
      messages: [], has_more: false,
      subagents: [
        { agent_id: 'agent-lead', label: 'Lead', description: 'Lead', parent_agent_id: 'main', status: 'running', started_at: DISPATCH_START, created_at: LEAD_BIRTH },
        { agent_id: 'agent-old', label: 'Earlier work', description: 'Earlier work', parent_agent_id: 'agent-lead', status: 'running', started_at: OLD_RESUME, created_at: OLD_BIRTH },
        { agent_id: 'agent-new', label: 'This run', description: 'This run', parent_agent_id: 'agent-lead', status: 'running', started_at: NEW_BIRTH, created_at: NEW_BIRTH },
      ].map((entry) => ({ id: `task-${entry.agent_id}`, session_id: SID, kind: 'subagent', ...entry })),
      agent_transcripts: {
        // Main dispatched `agent-lead`; the card for it is what the main
        // timeline shows, and its own children hang off that card.
        main: {
          agent_id: 'main', has_more: false,
          tasks: [task('agent-lead', 'Lead', 'running', DISPATCH_START, undefined)],
          items: [turn([
            tool('call-lead', 'agent-lead', DISPATCH_START),
          ], DISPATCH_START)],
        },
        'agent-lead': {
          agent_id: 'agent-lead', has_more: false,
          tasks: [
            task('agent-old', 'Earlier work', 'running', OLD_RESUME, undefined),
            task('agent-new', 'This run', 'running', NEW_BIRTH, undefined),
          ],
          items: [turn([
            tool('call-old', 'agent-old', OLD_RESUME),
            tool('call-new', 'agent-new', NEW_BIRTH),
          ], DISPATCH_START)],
        },
        'agent-old': { agent_id: 'agent-old', has_more: false, tasks: [], items: [] },
        'agent-new': { agent_id: 'agent-new', has_more: false, tasks: [], items: [] },
      },
    },
  },
};

export const EXPECT = { LEAD: 'agent-lead', OLD: 'agent-old', NEW: 'agent-new', SID };
export const HOURS = { HOUR };