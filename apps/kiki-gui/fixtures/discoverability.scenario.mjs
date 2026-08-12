/**
 * discoverability — batch-3 visual proof fixture: three pending approvals on a
 * busy session (batch bar + kbd hints + header badge), 80%+ context usage for
 * the composer meter, store-driven mode pills via agent_config, a second
 * session with a pending question (global sidebar badge), and an empty idle
 * session (collapsed right rail).
 */

import { fid, sessionRecord, ts, userMsg } from './helpers.mjs';

const SID = 'session_fixture_discover';
const SID_Q = 'session_fixture_discover_q';
const SID_EMPTY = 'session_fixture_discover_empty';

const expires = new Date(Date.now() + 23 * 3600_000).toISOString();
const created = new Date().toISOString();

function approval(id, toolName, action, display, toolCallId) {
  return {
    approval_id: id,
    session_id: SID,
    turn_id: 1,
    tool_call_id: toolCallId,
    tool_name: toolName,
    action,
    tool_input_display: display,
    created_at: created,
    expires_at: expires,
  };
}

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: discoverability',
      busy: true,
      pending_interaction: 'approval',
      agent_config: { model: 'kimi-for-coding', permission_mode: 'auto', plan_mode: true },
      usage: {
        input_tokens: 96_400,
        output_tokens: 12_100,
        cache_read_tokens: 48_000,
        cache_creation_tokens: 0,
        total_cost_usd: 0.213,
        context_tokens: 212_000,
        context_limit: 262_144,
        turn_count: 9,
      },
    }),
    sessionRecord(SID_Q, {
      title: 'Fixture: question waiting',
      busy: true,
      pending_interaction: 'question',
    }),
    sessionRecord(SID_EMPTY, {
      title: 'Fixture: quiet session',
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'Run the three setup commands and keep the changes minimal.', 6),
        {
          id: fid('msg'),
          session_id: SID,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'On it — I need your approval for each of the three commands before I can run them.',
            },
          ],
          created_at: ts(5),
        },
      ],
      pending_approvals: [
        approval('approval_disc_install', 'Bash', 'Running: pnpm install', { kind: 'command', command: 'pnpm install' }, fid('call')),
        approval('approval_disc_test', 'Bash', 'Running: pnpm test', { kind: 'command', command: 'pnpm test -- --run' }, fid('call')),
        approval('approval_disc_edit', 'Edit', 'Editing C:/fixture/workshop/bench.md', { kind: 'file_io', operation: 'edit', path: 'C:/fixture/workshop/bench.md' }, fid('call')),
      ],
    },
    [SID_Q]: {
      messages: [userMsg(SID_Q, 'Which workspace should I use?', 8)],
      pending_questions: [
        {
          question_id: 'question_disc_1',
          session_id: SID_Q,
          turn_id: 1,
          tool_call_id: fid('call'),
          questions: [
            {
              id: 'q1',
              question: 'Which target should the build optimize for?',
              options: [
                { id: 'opt_speed', label: 'Speed', description: 'Favor runtime speed over bundle size.' },
                { id: 'opt_size', label: 'Size', description: 'Favor a smaller bundle.' },
              ],
              multi_select: false,
              allow_other: false,
            },
          ],
          created_at: created,
        },
      ],
    },
    [SID_EMPTY]: {
      messages: [],
    },
  },
};
