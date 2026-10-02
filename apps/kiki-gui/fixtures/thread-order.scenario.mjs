import basicStream from './basic-stream.scenario.mjs';
import { commitAssistant, sessionRecord, streamSteps, ts, turnEnd, turnStart, workChanged } from './helpers.mjs';

const ROOT = 'session_fixture_parent';
const OTHER = 'session_fixture_recent';
const CHILD = 'session_fixture_child';

export default {
  agentPanel: basicStream.agentPanel,
  sessions: [
    sessionRecord(OTHER, { title: 'Recent independent thread', updated_at: ts(60) }),
    sessionRecord(ROOT, { title: 'Older parent thread', updated_at: ts(120) }),
    sessionRecord(CHILD, {
      title: 'Child review thread',
      updated_at: ts(180),
      metadata: { cwd: 'C:/fixture/workshop', created_by_session_id: ROOT, created_by_agent_id: 'main' },
    }),
  ],
  snapshots: { [CHILD]: { messages: [] } },
  onPrompt(_text, _sessionId, session) {
    session.record.updated_at = new Date().toISOString();
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
