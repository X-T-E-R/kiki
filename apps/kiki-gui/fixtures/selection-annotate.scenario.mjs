/**
 * selection-annotate — a seeded assistant paragraph the walker selects from:
 * fragments of it become annotation chips (quote + one-line comment) and a
 * plain quote chip, and the sent prompt is asserted on the control plane
 * (`last_prompt_submission`) to carry the blockquote + `Comment:` segments
 * ahead of the typed text.
 */

import {
  assistantMsg,
  commitAssistant,
  promptDone,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  userMsg,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_selection_annotate';
const REPLY = 'Selection annotations received by the fixture.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: selection annotate' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'How does the transcript stay responsive?', 9),
        assistantMsg(
          SID,
          [
            'The renderer batches transcript blocks into floors so long sessions stay cheap.\n\nQueue promotion drains parked prompts in order when a turn completes.',
          ],
          8,
        ),
      ],
      has_more: false,
    },
  },
  onPrompt: (_text, _sessionId, session) => {
    const turnId = session.messages.filter((message) => message.role === 'user').length;
    const submitted = session.lastPromptSubmission?.content.find((part) => part.type === 'text');
    return [
      turnStart(turnId),
      workChanged(true),
      { frame: { type: 'turn.step.started', payload: { turnId, step: 1 } } },
      ...streamSteps('assistant.delta', turnId, REPLY, { per: 20, delay: 20 }),
      { frame: { type: 'turn.step.completed', payload: { turnId, step: 1 } } },
      turnEnd(turnId),
      commitAssistant('$SID', REPLY),
      promptDone(),
      workChanged(false),
      { reseed: { presentation: submitted?.presentation } },
    ];
  },
};
