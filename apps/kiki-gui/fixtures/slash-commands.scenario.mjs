/**
 * slash-commands — a session with a seeded skill catalog: two activatable
 * skills and one reference-type skill (server rejects activation with 40912,
 * the menu greys it out). Plain prompts get a short canned reply so the
 * unknown-`/command` degradation is observable.
 */

import {
  commitAssistant,
  promptDone,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  userMsg,
  assistantMsg,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_slash';
const REPLY = 'Plain prompt received by the fixture.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: slash commands' })],
  snapshots: {
    [SID]: {
      messages: [
        userMsg(SID, 'Earlier exchange about the review flow.', 30),
        assistantMsg(SID, ['Use /review to run the review skill on the current diff.'], 29),
      ],
      has_more: false,
    },
  },
  skills: [
    {
      name: 'review',
      description: 'Review the current diff for risks',
      path: 'C:/fixture/skills/review/SKILL.md',
      source: 'project',
    },
    {
      name: 'handoff',
      description: 'Write a handoff note for the next session',
      path: 'C:/fixture/skills/handoff/SKILL.md',
      source: 'user',
    },
    {
      name: 'glossary',
      description: 'Project glossary (reference material, not runnable)',
      path: 'C:/fixture/skills/glossary/SKILL.md',
      source: 'project',
      type: 'reference',
    },
  ],
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
