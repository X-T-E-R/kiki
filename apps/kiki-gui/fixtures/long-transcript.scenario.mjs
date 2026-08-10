/**
 * long-transcript — 64 journaled turns (the snapshot page holds the latest
 * 50; 14 older ride the messages cursor) with long code fences sprinkled in.
 * Proves top-of-scroll pagination with anchoring, the turn-jump dropdown,
 * and the jump-to-bottom pill.
 */

import { assistantMsg, commitAssistant, sessionRecord, streamSteps, turnEnd, turnStart, userMsg, workChanged } from './helpers.mjs';

const SID = 'session_fixture_long';

const CODE = `\`\`\`ts
export interface WorkshopBench {
  vise: 'front' | 'tail';
  dogs: number;
  finish: 'oil' | 'wax' | 'shellac';
}

export function plane(board: string, passes: number): string {
  let surface = board;
  for (let i = 0; i < passes; i += 1) {
    surface = surface.trim();
  }
  return surface;
}

// A long code block so the collapse affordance shows.
export const GRITS = [80, 120, 180, 220, 320, 400];
export const OILS = ['tung', 'danish', 'linseed'];
export function label(grit) {
  return 'pass at grit ' + grit;
}
\`\`\``;

const TOPICS = [
  'sharpening angles', 'mortise layout', 'grain direction', 'hand-cut dovetails',
  'oil vs wax', 'panel glue-ups', 'winding sticks', 'scraping tear-out',
];

const older = [];
const recent = [];
for (let i = 0; i < 64; i += 1) {
  const topic = TOPICS[i % TOPICS.length];
  const minutesAgo = (64 - i) * 3;
  const user = userMsg(SID, `Turn ${i + 1}: tell me about ${topic}.`, minutesAgo);
  const assistant = assistantMsg(
    SID,
    [
      `About ${topic} (turn ${i + 1}): the short answer is to work with the grain, not against it.` +
        (i % 5 === 2 ? `\n\n${CODE}` : ''),
    ],
    minutesAgo - 1,
  );
  (i < 39 ? older : recent).push(user, assistant);
}

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: long transcript', message_count: 128 })],
  snapshots: {
    [SID]: { messages: recent, has_more: true, older },
  },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    ...streamSteps('assistant.delta', 1, 'Still here — the whole history is journaled above.', { per: 24 }),
    turnEnd(1),
    commitAssistant('$SID', 'Still here — the whole history is journaled above.'),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
