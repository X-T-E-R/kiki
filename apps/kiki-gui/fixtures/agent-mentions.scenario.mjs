/**
 * agent-mentions — the composer `@` menu's agent group: a session whose
 * `GET /agents/references` seed lists native and external engine targets, one
 * of them dimmed with its unavailable reason, beside a small workspace file
 * index. The walker opens the menu, filters, picks an agent (the draft gains
 * the server's `kiki://agents/…` link verbatim and a tinted token), sends, and
 * inspects `last_prompt_submission` for the link in the text part.
 */

import {
  commitAssistant,
  promptDone,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_agent_mentions';
const REPLY = 'Agent reference received by the fixture.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: agent mentions' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  fsEntries: [
    { path: 'src', name: 'src', kind: 'directory' },
    { path: 'README.md', name: 'README.md', kind: 'file' },
    { path: 'src/server.ts', name: 'server.ts', kind: 'file' },
  ],
  // The wire shape of `GET /agents/references`, replayed verbatim by the
  // fixture server. Codex's profile is a fixable fault: available=false with a
  // reason. delegation_available stays true here; the no-delegation banner is
  // exercised in the unit/component tests instead.
  agentReferences: {
    delegation_available: true,
    items: [
      {
        profile: 'agent',
        label: 'agent',
        executor: 'native',
        engine_label: 'Kiki',
        reference: 'kiki://agents/agent',
        configuration: 'native',
        group: 'native',
        defaults_available: true,
        available: true,
        description: 'The built-in Kiki agent',
      },
      {
        profile: 'codex',
        label: 'codex',
        executor: 'codex',
        engine_label: 'Codex',
        reference: 'kiki://agents/codex',
        configuration: 'profile',
        group: 'profile',
        defaults_available: false,
        available: false,
        unavailable_reason: 'Codex is not installed on this machine',
        unavailable_reason_code: 'executor_not_installed',
        description: 'Run on the Codex engine',
      },
      {
        profile: 'claude-code',
        label: 'claude-code',
        executor: 'claude-code',
        engine_label: 'Claude Code',
        reference: 'kiki://agents/claude-code',
        configuration: 'profile',
        group: 'profile',
        defaults_available: true,
        available: true,
        description: 'Run on the Claude Code engine',
      },
    ],
  },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, REPLY, { per: 20, delay: 20 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    turnEnd(1),
    commitAssistant('$SID', REPLY),
    promptDone(),
    workChanged(false),
  ],
};
