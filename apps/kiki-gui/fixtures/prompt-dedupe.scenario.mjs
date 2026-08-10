import { commitAssistant, sessionRecord, streamSteps, turnEnd, workChanged } from './helpers.mjs';

const SID = 'session_fixture_prompt_dedupe';
const PROMPT = 'One prompt, one user block.';
const ANSWER = 'The prompt appears once.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: prompt dedupe' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  // Mirrors the real v2 wire: turn.started is published before the REST submit
  // reply, while prompt.submitted is declared by protocol but not emitted.
  onSubmitBeforeResponse: [
    { type: 'turn.started', payload: { turnId: 1, origin: { kind: 'user' }, prompt: PROMPT } },
    { type: 'event.session.work_changed', payload: { busy: true } },
  ],
  onPrompt: [
    ...streamSteps('assistant.delta', 1, ANSWER, { per: 10, delay: 25 }),
    turnEnd(1),
    commitAssistant('$SID', ANSWER),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
