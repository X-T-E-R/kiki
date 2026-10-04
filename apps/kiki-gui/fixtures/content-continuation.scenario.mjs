/**
 * content-continuation — bodies the window had to cut, served through the real
 * bounded-content contract (1 KiB text preview, ≤32 KiB per segment):
 *
 *   - turn 1: a small exchange. Nothing is cut, so nothing may be offered.
 *   - turn 2: a Read whose output is ~40 KiB (tool output, frame-sourced) and a
 *     Write whose `input.content` is ~6 KiB (tool args, frame-sourced).
 *   - turn 3: eight steps; the window carries four, so the turn's own step list
 *     is the structural case (turn-sourced array ref).
 *   - turn 4: a shell task whose tail is ~6 KiB and is displayed through the
 *     task (`outputTaskId`), not through the frame.
 *
 * The scenario declares which entities the fixture bounds; the fixture applies
 * the production `boundedEntity` to exactly those, so the previews, refs and
 * segment reads come from the real functions rather than a fixture re-implementation.
 * All content is synthetic build log text; nothing mirrors a real session.
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_content_bounded';

/** Deterministic synthetic log text of at least `bytes` characters. */
function logText(bytes) {
  let text = '';
  for (let index = 0; text.length < bytes; index += 1) {
    text += `[line ${String(index).padStart(5, '0')}] synthetic build log for the bounded-content fixture\n`;
  }
  return text;
}

function turnItem(turnId, prompt, steps, minutesAgo) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state: 'completed',
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps,
  };
}

function step(turnId, ordinal, frames) {
  return {
    kind: 'step',
    stepId: `${turnId}.${ordinal}`,
    turnId,
    ordinal,
    state: 'completed',
    startedAt: ts(30),
    endedAt: ts(29),
    frames,
  };
}

function toolFrame(frameId, toolCallId, name, input, output) {
  return { kind: 'tool', frameId, toolCallId, name, state: 'done', input, output };
}

const BIG_OUTPUT = logText(40 * 1024);
const SCRIPT = logText(6 * 1024).split('\n').map((line, index) => `echo "${index} ${line.trim()}"`).join('\n');
const SHELL_TAIL = logText(6 * 1024);
// The session snapshot's own preview is 1 KiB per text field, so a title long
// enough to be cut is the root-level case: the header shows the preview and
// reads the rest one segment at a time.
const SESSION_TITLE = `Fixture: bounded content — ${'summarize the bounded-content contract and say where each cut field continues. '.repeat(20)}`.slice(0, 1400);

export default {
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
  ],
  sessions: [sessionRecord(SID, { title: SESSION_TITLE })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // Which entities the fixture bounds with the production functions: the
      // frame ids it cuts as frames, the turns it cuts as whole items (their
      // step list), the tasks it cuts as collection entities, and `root` for
      // the session snapshot itself (a root field the header shows).
      bounded_content: {
        root: true,
        frames: ['tool-read-big', 'tool-script-big'],
        turns: ['3'],
        tasks: ['task-shell'],
      },
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          seq: 24,
          items: [
            turnItem('1', 'Fixture: a small exchange with nothing cut.', [
              step('1', 1, [
                { kind: 'text', frameId: 't1-ask', role: 'user', text: 'Summarize the build in one line.' },
                { kind: 'text', frameId: 't1-answer', role: 'assistant', text: 'The build is green; 214 tests passed in 39 seconds.' },
              ]),
            ], 40),
            turnItem('2', 'Fixture: read the log and run the long build script.', [
              step('2', 1, [
                toolFrame('tool-read-big', 'read-big', 'Read', { path: 'build/full.log' }, BIG_OUTPUT),
                // A long script is the tools-args case: the command line in the
                // shell card is the reading area that continues.
                toolFrame('tool-script-big', 'script-big', 'Bash', { command: SCRIPT }, 'exit 0'),
              ]),
            ], 32),
            turnItem('3', 'Fixture: eight small steps, only four delivered.', Array.from({ length: 8 }, (_, index) =>
              step('3', index + 1, [
                toolFrame(`tool-step-${index + 1}`, `step-${index + 1}`, 'Glob', { pattern: `packages/*/src/${index + 1}.ts` }, `packages/pkg-${index + 1}/src/${index + 1}.ts`),
              ])), 24),
            turnItem('4', 'Fixture: a long shell run.', [
              step('4', 1, [
                {
                  kind: 'tool', frameId: 'tool-shell-big', toolCallId: 'shell-big', name: 'Bash', state: 'done',
                  input: { command: 'pnpm build --reporter=verbose' }, taskId: 'task-shell',
                  output: 'backgrounded',
                },
              ]),
            ], 16),
          ],
          tasks: [
            {
              taskId: 'task-shell', kind: 'shell', state: 'completed', detached: true,
              description: 'pnpm build --reporter=verbose', outputTail: SHELL_TAIL,
              startedAt: ts(16), endedAt: ts(14),
            },
          ],
        },
      },
    },
  },
};
