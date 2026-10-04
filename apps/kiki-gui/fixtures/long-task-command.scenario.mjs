/**
 * long-task-command — the background task detail modal under commands that do
 * not fit on a screen.
 *
 * Three running tasks, each a different shape of "too long":
 *   1. a multi-line shell script (the reported case: the command block grew
 *      until the output pane was squeezed to a sliver and nothing scrolled),
 *   2. one unbreakable ~4 KB single-line token (breaks horizontally, not
 *      vertically — a different failure mode from the same dialog),
 *   3. a short command (the control: a short task must not gain chrome).
 *
 * Every command and output string is synthetic placeholder text. Nothing here
 * connects to, executes or installs anything.
 *
 * Fixture-server data only (see helpers.mjs).
 */

import { sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_long_task_command';

// A multi-line build script: the shape that pushed the old layout past its cap.
const SCRIPT_COMMAND = [
  'bash -lc \'set -euo pipefail',
  'root="C:/Programs/AI/EasyAgent"',
  'log="$root/.tmp/fixture-install.log"',
  'if [ ! -d "$root" ]; then echo "workspace root missing" >&2; exit 2; fi',
  'echo "step 1/9: resolving toolchain"',
  'echo "step 2/9: verifying signatures"',
  'echo "step 3/9: extracting archives"',
  'echo "step 4/9: staging runtime"',
  'echo "step 5/9: linking binaries"',
  'echo "step 6/9: warming caches"',
  'echo "step 7/9: running migrations"',
  'echo "step 8/9: starting services"',
  'echo "step 9/9: done"',
  '\' | tee -a "$log"',
].join('\n');

// One token with nowhere to wrap: 4 KB, horizontally overflowing.
const SINGLE_LINE_COMMAND = `powershell -NoProfile -EncodedCommand ${'ZQBjAGgAbwByAE8A'.repeat(330)}`;

const SCRIPT_OUTPUT = [
  'C:/Programs/AI/EasyAgent fixture build log',
  '',
  '[1/9] resolving toolchain ....... ok (2.1s)',
  '[2/9] verifying signatures ...... ok (11.4s)',
  '[3/9] extracting archives ....... ok (48.9s)',
  '[4/9] staging runtime ........... ok (6.2s)',
  '[5/9] linking binaries .......... ok (3.8s)',
  '[6/9] warming caches ............ ok (0.9s)',
  '[7/9] running migrations ........ ok (17.2s)',
  '[8/9] starting services ......... ok (1.4s)',
  '[9/9] done',
  '',
  'result: 9 steps, 0 failures, elapsed 1m 32s',
].join('\n');

// Enough lines to make the output pane scroll on its own.
const LONG_OUTPUT = Array.from(
  { length: 220 },
  (_, index) => `[${String(index + 1).padStart(3, '0')}] transform ${index % 7 === 0 ? 'ok' : 'ok'} (${(index * 13) % 900 + 12}ms)  module-${index}.ts`,
).join('\n');

const ago = (minutes) => ts(minutes);

/**
 * The rail only lists running non-subagent tasks (`backgroundTasks` in
 * rail-variants/Rail.tsx), so every task here must stay `running` to be
 * reachable. The "short command" case is a short *command* on a live task, not
 * a settled one — that is the shape the rail can actually open.
 */
const tasks = [
  {
    id: 'task_fixture_long_script',
    session_id: SID,
    kind: 'bash',
    description: 'release build and runtime warmup',
    status: 'running',
    command: SCRIPT_COMMAND,
    created_at: ago(9),
    started_at: ago(9),
    output_preview: SCRIPT_OUTPUT,
    output_bytes: SCRIPT_OUTPUT.length,
  },
  {
    id: 'task_fixture_single_line',
    session_id: SID,
    kind: 'bash',
    description: 'encoded provisioning command',
    status: 'running',
    command: SINGLE_LINE_COMMAND,
    created_at: ago(3),
    started_at: ago(3),
    output_preview: LONG_OUTPUT,
    output_bytes: LONG_OUTPUT.length,
  },
  {
    id: 'task_fixture_short_command',
    session_id: SID,
    kind: 'bash',
    description: 'lint pass',
    status: 'running',
    command: 'pnpm lint',
    created_at: ago(14),
    started_at: ago(14),
    output_preview: 'checked 412 files, 0 problems',
    output_bytes: 31,
  },
];

export default {
  sessions: [
    sessionRecord(SID, {
      title: 'Fixture: long task command',
      busy: true,
      main_turn_active: true,
    }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      in_flight_turn: {
        turn_id: 1,
        assistant_text: 'Building in the background — the output pane streams the tail.',
        thinking_text: '',
        running_tools: [],
      },
      tasks,
    },
  },
};

export const LONG_TASK_COMMAND = { SID, tasks };
export { SINGLE_LINE_COMMAND, SCRIPT_COMMAND, SCRIPT_OUTPUT, LONG_OUTPUT };
