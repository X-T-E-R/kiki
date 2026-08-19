/**
 * rewrite-flow — the message-closure proving ground. Three settled turns
 * (floor nav ≥ 2 floors), one deliberately LONG user message (collapsible
 * overflow), and a distinct tail turn that edit/regenerate truncate away.
 *
 * onPrompt replies are keyed by prompt text so the walker can tell which
 * rewrite produced the answer: an edited prompt gets the "edited" reply, a
 * regenerated one the "regenerated" reply, anything else the fallback.
 */

import {
  assistantMsg,
  commitAssistant,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  userMsg,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_rewrite';

const LONG_USER = [
  'Audit the fixture workspace end to end. The brief is long on purpose so',
  'this card overflows the collapse clamp and shows the expand affordance.',
  ...Array.from(
    { length: 14 },
    (_, index) => `Requirement ${index + 1}: check surface ${index + 1} and report drift.`,
  ),
  'Summarize at the end.',
].join('\n');

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: rewrite flow' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'First fixture question — floor one.', 30),
        assistantMsg(SID, ['First fixture answer.'], 29),
        userMsg(SID, LONG_USER, 28),
        assistantMsg(SID, ['Audit complete — all surfaces clean.'], 27),
        userMsg(SID, 'Tail question that edits will truncate.', 26),
        assistantMsg(SID, ['TAIL-REPLY doomed to be rewritten away.'], 25),
      ],
      has_more: false,
    },
  },
  onPrompt: (text) => {
    const reply = text.includes('edited resend')
      ? 'EDITED-REPLY landed after the rewrite.'
      : text.includes('Tail question')
        ? 'REGENERATED-REPLY replaced the old tail.'
        : 'Plain fixture reply.';
    return [
      turnStart(1, text),
      workChanged(true),
      { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
      ...streamSteps('assistant.delta', 1, reply, { per: 24, delay: 20 }),
      { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
      turnEnd(1),
      commitAssistant('$SID', reply),
      { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
      workChanged(false),
    ];
  },
};
