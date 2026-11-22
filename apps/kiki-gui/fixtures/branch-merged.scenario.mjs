/**
 * branch-merged — one session with a merged branch and an open branch, so the
 * branch workspace can be shown in both states: a merged branch keeps a live
 * composer with the "send a message to continue" seam and the split-out
 * action, and an open branch offers both the split-out and merge actions.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_branch_merged';
const MODEL = 'fixture/kiki-pro';
const NOW = new Date().toISOString();

function branchTranscript(agentId, prompt, answer) {
  return {
    agent_id: agentId,
    has_more: false,
    items: [
      {
        kind: 'turn',
        turnId: 't1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user' },
        prompt,
        startedAt: NOW,
        endedAt: NOW,
        steps: [
          {
            kind: 'step',
            stepId: 't1.1',
            turnId: 't1',
            ordinal: 1,
            state: 'completed',
            startedAt: NOW,
            endedAt: NOW,
            frames: [{ kind: 'text', frameId: `${agentId}-answer`, role: 'assistant', text: answer }],
          },
        ],
      },
    ],
  };
}

export default {
  models: [{ id: MODEL, provider_id: 'fixture', remote_id: 'kiki-pro', display_name: 'Kiki Pro', max_context_size: 262_144 }],
  sessions: [sessionRecord(SID, { title: 'Fixture: branch lifecycle', agent_config: { model: MODEL } })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      subagents: [
        { id: 'task-branch-merged', session_id: SID, kind: 'subagent', agent_id: 'branch-merged', label: 'Lockfile audit', parent_agent_id: 'main', status: 'completed', activity_status: 'completed', status_source: 'metadata', description: 'Lockfile audit', started_at: NOW, completed_at: NOW, live: true, executor_id: 'native', model: MODEL, is_branch: true, branch_seed: 'fresh', branch_sealed: true, tools_locked: false },
        { id: 'task-branch-open', session_id: SID, kind: 'subagent', agent_id: 'branch-open', label: 'Release notes draft', parent_agent_id: 'main', status: 'completed', activity_status: 'idle', status_source: 'runtime', description: 'Release notes draft', started_at: NOW, live: true, executor_id: 'native', model: MODEL, is_branch: true, branch_seed: 'fresh', branch_sealed: false, tools_locked: false },
      ],
      agent_transcripts: {
        'branch-merged': branchTranscript('branch-merged', 'Check whether the lockfile drifted after the upgrade.', 'No drift: the offline frozen install reproduces the lockfile exactly.'),
        'branch-open': branchTranscript('branch-open', 'Draft release notes for the patch upgrade.', 'Drafted three bullet points covering the patch upgrade.'),
      },
    },
  },
};
