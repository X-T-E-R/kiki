/**
 * attachments — a session with a seeded workspace file index for the `@`
 * picker (dirs-first top level on an empty query, substring match after),
 * plus a canned reply so the walker can send a prompt carrying a file
 * mention chip and a pasted image and then inspect `last_prompt_submission`.
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

const SID = 'session_fixture_attach';
const REPLY = 'Attachments received by the fixture.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: attachments' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  fsEntries: [
    { path: 'src', name: 'src', kind: 'directory' },
    { path: 'docs', name: 'docs', kind: 'directory' },
    { path: 'README.md', name: 'README.md', kind: 'file' },
    { path: 'package.json', name: 'package.json', kind: 'file' },
    { path: 'src/server.ts', name: 'server.ts', kind: 'file' },
    { path: 'src/server.test.ts', name: 'server.test.ts', kind: 'file' },
    { path: 'src/serial port.ts', name: 'serial port.ts', kind: 'file' },
    { path: 'docs/design.md', name: 'design.md', kind: 'file' },
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
