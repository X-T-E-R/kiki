/**
 * agent-mentions-delegation — the composer `@` menu when the current engine
 * cannot delegate: `delegation_available: false`. The agent groups stay listed
 * with a banner saying references are just mentions, carrying the server's
 * reason, instead of being silently dropped.
 */

import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_agent_mentions_nodeleg';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: agent mentions (no delegation)' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  fsEntries: [
    { path: 'README.md', name: 'README.md', kind: 'file' },
  ],
  agentReferences: {
    delegation_available: false,
    unavailable_reason: 'External dispatch is off for this engine',
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
  onPrompt: [],
};
