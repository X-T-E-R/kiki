/**
 * error-abort — on prompt: a failing tool call (isError result) followed by a
 * slow stream the runner aborts mid-flight → prompt.aborted + turn.ended
 * (cancelled) arrive over the wire. Proves the aborted notice, the failed
 * tool card, and the group's auto-expand-on-error.
 */

import {
  approvalFrame,
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_abort';
const FAIL_CALL = fid('call');
const SLOW_CALL = fid('call');

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: error + abort' })],
  snapshots: { [SID]: { messages: [] } },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: FAIL_CALL, name: 'Bash',
          args: { command: 'exit 3' },
          display: { kind: 'command', command: 'exit 3' },
        },
      },
    },
    { delay: 200 },
    { frame: approvalFrame({ toolName: 'Bash', action: 'Running: exit 3', display: { kind: 'command', command: 'exit 3' }, toolCallId: FAIL_CALL }) },
    { waitFor: 'approval' },
    { delay: 300 },
    {
      frame: {
        type: 'tool.result',
        payload: {
          turnId: 1, toolCallId: FAIL_CALL, isError: true,
          output: { kind: 'command_output', exit_code: 3, stderr: 'fixture failure: forced exit' },
        },
      },
    },
    { delay: 250 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1, toolCallId: SLOW_CALL, name: 'Read',
          args: { file_path: 'C:/fixture/workshop/slow.log' },
          display: { kind: 'file_io', operation: 'read', path: 'C:/fixture/workshop/slow.log' },
        },
      },
    },
    { delay: 200 },
    { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: SLOW_CALL, output: { kind: 'file_content', path: 'C:/fixture/workshop/slow.log', content: 'line\n' } } } },
    { delay: 300 },
    // A deliberately slow stream the runner aborts part-way through.
    ...streamSteps('assistant.delta', 1, 'The first command failed; recovering slowly' + ' …'.repeat(40), { per: 10, delay: 220 }),
    // Reached only if never aborted (the proof aborts long before this).
    turnEnd(1),
    commitAssistant('$SID', 'The first command failed; recovering slowly.'),
    workChanged(false),
  ],
};
