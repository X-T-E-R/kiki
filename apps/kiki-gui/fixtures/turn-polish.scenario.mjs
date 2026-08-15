/**
 * turn-polish — turn-level display states:
 *
 *   1. "Abort me mid-stream." (turnId 1): a running Bash tool plus a slow
 *      stream the proof aborts via Escape → the fixture server answers with
 *      turn.ended(cancelled) (no durationMs — exercises the timestamp-derived
 *      fallback), leaving a Stopped marker on the assistant message and the
 *      amber stopped square on the orphaned tool card.
 *   2. "Think slowly before answering." (turnId 2): a deliberate 16.5s
 *      first-token gap → the turn status line appears immediately and its
 *      cumulative clock once the wait passes 15s; turn.ended then carries an
 *      explicit durationMs so the turn tail shows "Ran for … · TTFT …".
 *
 * Turn ids: the fixture server's abort path emits turn.ended with a hardcoded
 * turnId of 1, so the abort turn must be 1 and the slow turn 2.
 */

import {
  commitAssistant,
  fid,
  sessionRecord,
  streamSteps,
  turnEnd,
  turnStart,
  workChanged,
} from './helpers.mjs';

const SID = 'session_fixture_turn_polish';
const HANG_CALL = fid('call');

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: turn polish' })],
  snapshots: { [SID]: { messages: [] } },
  onPrompt: (text) => {
    if (text.startsWith('Abort me')) {
      return [
        turnStart(1, text),
        workChanged(true),
        {
          frame: {
            type: 'tool.call.started',
            payload: {
              turnId: 1, toolCallId: HANG_CALL, name: 'Bash',
              args: { command: 'sleep 600' },
              display: { kind: 'command', command: 'sleep 600' },
            },
          },
        },
        { delay: 300 },
        // Slow stream the proof aborts part-way through; the tool.result and
        // turnEnd below are only reached if the abort never lands.
        ...streamSteps('assistant.delta', 1, 'This half-finished sentence keeps streaming' + ' …'.repeat(60), { per: 12, delay: 240 }),
        { frame: { type: 'tool.result', payload: { turnId: 1, toolCallId: HANG_CALL, output: { kind: 'command_output', exit_code: 0, stdout: '' } } } },
        turnEnd(1),
        commitAssistant('$SID', 'This half-finished sentence keeps streaming.'),
        workChanged(false),
      ];
    }
    return [
      turnStart(2, text),
      workChanged(true),
      // First-token wait long enough to surface the status line clock (≥15s).
      { delay: 16_500 },
      { frame: { type: 'assistant.delta', offset: 0, payload: { turnId: 2, delta: 'The slow answer, finally.' } } },
      { delay: 250 },
      { frame: { type: 'turn.ended', payload: { turnId: 2, reason: 'completed', durationMs: 17_200 } } },
      { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
      workChanged(false),
    ];
  },
};
