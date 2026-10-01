/**
 * notes-rail — the rail's working-notes section (工作笔记) per agent.
 *
 * "Fixture: working notes" is idle. Main carries all eight note sections —
 * the evidence section long enough to clamp — plus a checklist, so the rail
 * reads 待办 over 笔记. Two finished subagents sit under it: one with its own
 * two-section notes (the rail's per-agent page switch), one that never wrote
 * notes (the empty state). No prompt script: the point is the rail, not a
 * turn.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_notes_rail';
const MODEL = 'fixture/kiki-pro';

const MAIN_NOTES = {
  goal: 'Prepare the 0.6 release checklist\nEvery step reproducible, nothing manual-only.',
  directives: 'Keep the checklist executable by a release bot; no manual-only steps.',
  decided: 'The changelog builds from merged PR titles, not from raw commit subjects.',
  rejected: 'A separate release-notes app — overkill for a monthly cadence.',
  evidence: [
    'Dry run against a copied workspace passed 41 of 43 checks.',
    'Check 17 (changelog diff) failed: PR titles carried merge-queue suffixes.',
    'Suffix stripping added; the rerun passed.',
    'Check 29 (arm64 smoke) timed out once, passed on retry.',
    'Upgrade rehearsal from 0.5.3 → 0.6.0-rc.1 kept settings and sessions.',
    'Fresh install profiled at 2.1 s to first prompt on the reference laptop.',
    'The rollback path restored 0.5.3 with the workspace intact.',
    'Signed installer verified on Windows and macOS.',
    'Not yet covered: the Linux tarball self-update.',
    'Known flake: check 29 needs a retry budget, not a fix.',
    'All evidence archived under release/0.6/rehearsal/.',
    'Sign-off pending from the release owner.',
  ].join('\n'),
  files: 'release/checklist.md · scripts/release.mjs · release/0.6/rehearsal/',
  next: 'Run the upgrade rehearsal once more against a fresh copy of the workspace.',
  open: 'Does the arm64 runner still time out on the smoke suite under load?',
};

const MAIN_TODOS = [
  { title: 'Draft the checklist skeleton', status: 'done' },
  { title: 'Verify each step on a clean machine', status: 'done' },
  { title: 'Run the upgrade rehearsal', status: 'in_progress' },
  { title: 'Publish the checklist', status: 'pending' },
];

/** One settled turn: user ask, one assistant text frame. */
function settledTurn(turnId, prompt, answer, minutesAgo) {
  return {
    kind: 'turn', turnId, ordinal: Number(turnId.slice(1)), state: 'completed', origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo), endedAt: ts(minutesAgo - 1),
    steps: [{
      kind: 'step', stepId: `${turnId}.1`, turnId, ordinal: 1, state: 'completed', startedAt: ts(minutesAgo), endedAt: ts(minutesAgo - 1),
      frames: [{ kind: 'text', frameId: `${turnId}-answer`, role: 'assistant', text: answer }],
    }],
  };
}

const rosterRow = (agentId, label, task, minutesAgo) => ({
  id: `task_${agentId}`,
  session_id: SID,
  kind: 'subagent',
  status: 'completed',
  description: task,
  agent_id: agentId,
  parent_agent_id: 'main',
  label,
  model: MODEL,
  thinking_effort: 'high',
  created_at: ts(minutesAgo + 1),
  started_at: ts(minutesAgo),
  completed_at: ts(Math.max(1, minutesAgo - 4)),
  output_preview: `Done; reported back to main.`,
  tool_call_count: 5,
  live: true,
});

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: working notes',
      created_at: ts(48),
      updated_at: ts(5),
      agent_config: { model: MODEL, permission_mode: 'auto' },
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      subagents: [
        rosterRow('agent-scout', 'Notes scout', 'Audit the notes surface at both rail widths', 30),
        rosterRow('agent-blank', 'Docs sweep', 'Sweep the docs for stale 0.5 links', 22),
      ],
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            settledTurn('t1', 'Prepare the 0.6 release checklist.', 'The checklist is drafted and the rehearsal is running; my working notes hold the details.', 40),
            // The dispatch card keeps the subagent reachable from the timeline
            // at widths where the rail (and its roster) is hidden.
            { kind: 'taskref', refId: 'ref-agent-scout', taskId: 'task_agent-scout', at: ts(29) },
          ],
          tasks: [{
            taskId: 'task_agent-scout',
            kind: 'subagent',
            state: 'completed',
            detached: false,
            agentId: 'agent-scout',
            name: 'Notes scout',
            description: 'Audit the notes surface at both rail widths',
            outputTail: '',
            resultSummary: 'Both widths read cleanly; the long evidence section clamps with a toggle.',
            startedAt: ts(30),
            endedAt: ts(26),
          }],
          todos: [{
            todoId: 'todo',
            items: MAIN_TODOS,
            notes: MAIN_NOTES,
            notesMeta: { rev: 4, hash: 'fixture-notes-r4', writtenTurn: 12, writtenStep: 't12.3', coveredMessageId: 'msg-9', windowEpoch: 1 },
          }],
          meta: {
            activity: 'idle',
            agent: {
              model: MODEL,
              thinkingEffort: 'high',
              permission: 'auto',
              contextTokens: 48_200,
              maxContextTokens: 262_144,
              phase: { kind: 'ended', turnId: 1, reason: 'completed', at: 0 },
            },
          },
        },
        'agent-scout': {
          agent_id: 'agent-scout',
          has_more: false,
          tool_call_count: 5,
          items: [
            settledTurn('t1', 'Audit the notes surface at both rail widths.', 'Both widths read cleanly; the long evidence section clamps with a toggle.', 30),
          ],
          todos: [{
            todoId: 'todo',
            items: [
              { title: 'Check the 1440 rail', status: 'done' },
              { title: 'Check the 390 overlay rail', status: 'done' },
            ],
            notes: {
              goal: 'Audit the notes surface at both rail widths',
              next: 'Report the width audit to main.',
            },
            notesMeta: { rev: 1, hash: 'fixture-scout-r1', writtenTurn: 3, writtenStep: 't3.1', coveredMessageId: 'msg-2', windowEpoch: 0 },
          }],
          meta: {
            activity: 'idle',
            agent: {
              model: MODEL,
              thinkingEffort: 'high',
              permission: 'auto',
              contextTokens: 12_600,
              maxContextTokens: 262_144,
              phase: { kind: 'ended', turnId: 1, reason: 'completed', at: 0 },
            },
          },
        },
        // Ran and reported without ever writing working notes: the empty state.
        'agent-blank': {
          agent_id: 'agent-blank',
          has_more: false,
          tool_call_count: 3,
          items: [
            settledTurn('t1', 'Sweep the docs for stale 0.5 links.', 'Six links updated; the sweep is done.', 22),
          ],
          meta: {
            activity: 'idle',
            agent: {
              model: MODEL,
              thinkingEffort: 'medium',
              permission: 'auto',
              contextTokens: 9_100,
              maxContextTokens: 262_144,
              phase: { kind: 'ended', turnId: 1, reason: 'completed', at: 0 },
            },
          },
        },
      },
    },
  },
};
