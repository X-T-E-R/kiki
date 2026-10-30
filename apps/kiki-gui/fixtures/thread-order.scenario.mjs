import basicStream from './basic-stream.scenario.mjs';
import { commitAssistant, sessionRecord, streamSteps, turnEnd, turnStart, workChanged } from './helpers.mjs';

const ROOT = 'session_fixture_parent';
const OTHER = 'session_fixture_recent';
const CHILD = 'session_fixture_child';

// Today/older share one local day, and the prompt's own clock stays inside it:
// the family-recency projection borrows the child's clock for the parent's
// bucket, and a fixed fixture epoch can land the rows on different sides of
// the local-day boundary against `new Date()`.
const NOW = Date.now();
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

export default {
  agentPanel: basicStream.agentPanel,
  sessions: [
    sessionRecord(OTHER, { title: 'Recent independent thread', updated_at: minutesAgo(60) }),
    sessionRecord(ROOT, { title: 'Older parent thread', updated_at: minutesAgo(120) }),
    sessionRecord(CHILD, {
      title: 'Child review thread',
      updated_at: minutesAgo(180),
      metadata: { cwd: 'C:/fixture/workshop', created_by_session_id: ROOT, created_by_agent_id: 'main' },
    }),
  ],
  snapshots: { [CHILD]: { messages: [] } },
  onPrompt(_text, _sessionId, session) {
    // kap-server keeps the session's own clock on `own_updated_at` and
    // aggregates visible family activity onto `updated_at` (its own plus an
    // attached child's). The child's own activity moves both fields.
    const at = new Date().toISOString();
    session.record.own_updated_at = at;
    session.record.updated_at = at;
    return [
      turnStart(1),
      workChanged(true),
      ...streamSteps('assistant.delta', 1, 'Child activity completed.', { per: 40 }),
      commitAssistant('$SESSION', 'Child activity completed.'),
      workChanged(false),
      turnEnd(1),
    ];
  },
};
