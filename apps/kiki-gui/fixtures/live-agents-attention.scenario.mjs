/**
 * live-agents-attention — the live-agents-compact fleet after a rough night:
 * one live session whose resume failed (the server kept its error) and one
 * session paused before a restart, which has left the live inventory and is
 * found only through the cold session summaries. Both need the user, so the
 * folded session list must keep them in view with their explicit actions.
 */

import { sessionRecord, ts } from './helpers.mjs';
import compact, { ETA } from './live-agents-compact.scenario.mjs';

export const PAUSED = 'session_e2f47b09-6d1c-4a38-b5f2-7c0e9d81a463';
export const FAILED_ERROR = 'Resume could not reattach the approval waiter';

export default {
  ...compact,
  executionControl: {
    ...compact.executionControl,
    [ETA]: {
      phase: 'failed',
      pauseOperationId: 'pause-fixture-eta',
      error: FAILED_ERROR,
      agents: [{ agentId: 'agent-explore-2', state: 'settling', resumable: false }],
    },
    [PAUSED]: {
      phase: 'paused',
      pauseOperationId: 'pause-fixture-nightly',
      pausedAt: ts(95),
      agents: [{ agentId: 'main', state: 'paused', resumable: true, turnId: 7 }],
    },
  },
  sessions: [
    ...compact.sessions,
    sessionRecord(PAUSED, {
      title: 'Fixture: nightly eval sweep',
      agent_config: { model: 'kimi/k2-thinking' },
      created_at: ts(600),
      updated_at: ts(95),
    }),
  ],
};
