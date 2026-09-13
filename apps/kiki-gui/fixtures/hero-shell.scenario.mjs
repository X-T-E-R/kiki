/**
 * hero-shell — same wire script as draft-flow (zero starting sessions, one
 * prompt → streamed answer), dedicated to the conversation-shell walker: hero
 * phase on /new, the single-tree composer flip into /s/:id, phase/geometry
 * screenshots across breakpoints.
 */

import {
  commitAssistant,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const ANSWER = 'Here is the fixture answer from the hero shell flow.';

export default {
  sessions: [],
  snapshots: {},
  // Agent picker proof: two main profiles lead the list, the enabled non-main
  // profile follows — every enabled profile is a conversation candidate now.
  agentProfiles: [
    {
      name: 'agent',
      source: 'builtin',
      description: 'General-purpose built-in agent.',
      main: true,
      routes: [],
    },
    {
      name: 'grok-only',
      source: 'user',
      description: 'Grok-only profile.',
      main: true,
      routes: [],
    },
    {
      name: 'reviewer',
      source: 'workspace',
      description: 'Reviews code changes.',
      main: false,
      routes: [],
    },
  ],
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('assistant.delta', 1, ANSWER, { per: 20, delay: 25 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    turnEnd(1),
    commitAssistant('$SID', ANSWER),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
