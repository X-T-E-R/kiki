/**
 * basic-stream — one idle session; on prompt: thinking → assistant markdown
 * (2x2 GFM table + a 16-line fenced bash block to prove code collapse) →
 * Bash tool call → approval gate (waitFor) → tool result → wrap-up text →
 * turn end. The canonical happy path.
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

const SID = 'session_fixture_basic';
const CALL = fid('call');

const MARKDOWN = `Here is the fixture answer with a table and a script.

| Name | Value |
| ---- | ----- |
| alpha | 1 |
| beta | 2 |

\`\`\`bash
#!/usr/bin/env bash
set -euo pipefail

echo "kiki fixture"
for i in 1 2 3 4 5; do
  echo "line $i"
done

# a tail of comments makes this block long
# enough to exercise the collapse affordance
# line twelve
# line thirteen
# line fourteen
echo done
\`\`\`

That is the whole answer.`;

const TAIL = 'The script ran — `kiki fixture` printed as expected.';

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: basic stream' })],
  snapshots: {
    [SID]: { messages: [], has_more: false },
  },
  onPrompt: [
    turnStart(1),
    workChanged(true),
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 1 } } },
    ...streamSteps('thinking.delta', 1, 'The user wants a table and a fenced script — keep it tight.', { per: 18 }),
    { delay: 200 },
    ...streamSteps('assistant.delta', 1, MARKDOWN, { per: 40, delay: 25 }),
    { delay: 300 },
    {
      frame: {
        type: 'tool.call.started',
        payload: {
          turnId: 1,
          toolCallId: CALL,
          name: 'Bash',
          args: { command: 'echo "kiki fixture"' },
          description: 'Run the fixture echo',
          display: { kind: 'command', command: 'echo "kiki fixture"' },
        },
      },
    },
    { delay: 250 },
    { frame: approvalFrame({ toolName: 'Bash', action: 'Running: echo "kiki fixture"', display: { kind: 'command', command: 'echo "kiki fixture"' }, toolCallId: CALL }) },
    workChanged(true, 'approval'),
    { waitFor: 'approval' },
    { delay: 400 },
    { frame: { type: 'tool.progress', payload: { turnId: 1, toolCallId: CALL, update: { kind: 'status', text: 'running' } } } },
    { delay: 500 },
    {
      frame: {
        type: 'tool.result',
        payload: {
          turnId: 1,
          toolCallId: CALL,
          output: { kind: 'command_output', exit_code: 0, stdout: 'kiki fixture\n' },
        },
      },
    },
    { delay: 250 },
    // Post-tool text arrives in a new step (offsets restart at 0, as on the wire).
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 1 } } },
    { frame: { type: 'turn.step.started', payload: { turnId: 1, step: 2 } } },
    ...streamSteps('assistant.delta', 1, TAIL, { per: 20, delay: 25 }),
    { frame: { type: 'turn.step.completed', payload: { turnId: 1, step: 2 } } },
    turnEnd(1),
    commitAssistant('$SID', `${MARKDOWN}\n\n${TAIL}`),
    { frame: { type: 'prompt.completed', payload: { promptId: '$PROMPT', finishedAt: new Date().toISOString(), reason: 'completed' } } },
    workChanged(false),
  ],
};
