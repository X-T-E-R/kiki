/**
 * marketing-p2-builders — locale-aware builders for the P2 shots (D01–D08).
 *
 * Mirrors `marketing-builders.mjs`: each `buildDX(locale)` returns the whole
 * fixture-server scenario for one shot in one locale, so ids and structure are
 * identical between the en and zh images and only the copy is translated. The
 * thin `marketing-d0X-<locale>.scenario.mjs` files are the entry points.
 *
 * The session-level state is reused from the P1 builders (`buildH01`,
 * `buildR01`) instead of being rebuilt: D01 is literally H01 with the Explorer
 * open in the preview workspace, and the settings/tasks/video shots start from
 * the same localized workbench so every image belongs to one product story.
 * Only the per-shot data (task rows, transcript messages, cron plans, attached
 * recording) is defined here.
 */

import { AGENT, SESSION, runningMeta, textFrame, toolFrame, turn } from './marketing-scene.mjs';
import { ts } from './helpers.mjs';
import { buildH01, buildR01 } from './marketing-builders.mjs';
import {
  navigationDemoBytes,
  navigationDemoDataUrl,
  p2CronTasks,
  p2NbSearchCapabilities,
  p2NbSearchConfig,
  p2NbSearchSourceConfig,
  p2NbSearchTest,
  pick,
} from './marketing-p2-scene.mjs';
import { fid, assistantMsg, originMsg, toolResultMsg, userMsg } from './helpers.mjs';

/** H01 with a quiet release session — the base for the settings-style shots. */
function quiet(locale) {
  return buildR01(locale);
}

// ---------------------------------------------------------------------------
// D01 — subagent preview tab
// ---------------------------------------------------------------------------

/**
 * Map a fixture snapshot task row onto the transcript's camelCase task shape.
 * The transcript route prefers `agent_transcripts.<agent>.tasks` verbatim, so
 * this is how a scenario gives a row its display name (`name`) — the field the
 * lifecycle entries and the dispatch tree label rows from.
 */
function toTranscriptTask(row) {
  return {
    taskId: row.id,
    kind: row.kind === 'bash' ? 'shell' : row.kind === 'subagent' ? 'subagent' : 'tool',
    state: row.status === 'cancelled' ? 'killed' : row.status,
    detached: row.run_in_background ?? true,
    name: row.label,
    subagentName: row.label,
    description: row.description,
    agentId: row.agent_id,
    outputTail: row.output_preview ?? '',
    resultSummary: row.output_preview,
    startedAt: row.started_at ?? row.created_at,
    endedAt: row.completed_at,
  };
}

/**
 * H01 as-is, plus the completed Explorer's transcript task row: the transcript
 * route prefers these rows verbatim, so the child gets a display name and its
 * taskref lands its card (with the result summary) in the main timeline — the
 * way the product folds a completed run. The panel tab itself is opened by the
 * walker through the real dispatch tree; no layout is pre-arranged.
 */
export function buildD01(locale) {
  const h01 = buildH01(locale);
  const release = h01.snapshots[SESSION.release];
  const explorerTask = release.subagents.find((row) => row.agent_id === AGENT.explorer);
  const main = release.agent_transcripts.main;
  const items = [...main.items];
  items.splice(1, 0, {
    kind: 'taskref',
    refId: `ref-${explorerTask.id}`,
    taskId: explorerTask.id,
    at: explorerTask.started_at,
  });
  return {
    ...h01,
    snapshots: {
      ...h01.snapshots,
      [SESSION.release]: {
        ...release,
        agent_transcripts: {
          ...release.agent_transcripts,
          main: {
            ...main,
            tasks: [...release.tasks.map(toTranscriptTask), toTranscriptTask(explorerTask)],
            items,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// D02 — prompt fields + variable preview
// ---------------------------------------------------------------------------

const SYSTEM_SHARED_FIELD = {
  en: 'Release channel: ${release_channel}. Freeze the changelog once the release tag is cut, and keep every claim traceable to a file in the repository.',
  zh: '发布通道：${release_channel}。切出发布标签后冻结更新日志，并让每条结论都能追溯到仓库里的文件。',
};

const WEB_SEARCH_FIELD = {
  en: 'When you search for sample-app APIs, prefer the official documentation and skip forum answers unless the docs stay silent.',
  zh: '搜索 sample-app 的 API 时优先使用官方文档；文档没有说明时再看论坛解答。',
};

/**
 * The settings → Agents page with one custom variable and two real field ids
 * (`system.shared`, `tool.web-search.guidance` — both registered by
 * builtinPromptFields.ts). The walker expands both the editor and the preview,
 * so the substitution is visible; the image claims field previewing, not the
 * final assembled model input.
 */
export function buildD02(locale) {
  const base = quiet(locale);
  return {
    ...base,
    config: {
      ...base.config,
      prompt: {
        variables: { release_channel: 'stable' },
        overrides: {
          files: [],
          fields: {
            'system.shared': SYSTEM_SHARED_FIELD[locale === 'zh' ? 'zh' : 'en'],
            'tool.web-search.guidance': WEB_SEARCH_FIELD[locale === 'zh' ? 'zh' : 'en'],
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// D03 — the session background-task browser
// ---------------------------------------------------------------------------

/** `/s/:id/tasks` with one running, one completed and one failed Bash task. */
export function buildD03(locale) {
  // A quiet session: background tasks outlive the turn that started them, and
  // an idle main turn keeps a resting 0:00 run timer out of the sidebar.
  const h01 = quiet(locale);
  const sessionId = SESSION.release;
  const running = [
    '> sample-app@0.4.0-rc.1 test',
    '> vitest --watch',
    '',
    ' ✓ specs/release.spec.ts (12 tests) 1184ms',
    ' ✓ specs/changelog.spec.ts (7 tests) 642ms',
    ' ✓ specs/accessibility.spec.ts (9 tests) 903ms',
    ' ❯ specs/upgrade-guide.spec.ts (4 tests | 1 skipped)',
    '',
    ' Test Files  3 passed | 1 running (4)',
    '      Tests  28 passed | 1 skipped (29)',
    '   Watching for file changes…',
  ].join('\n');
  const build = [
    '> docs@0.4.0 build',
    '> vite build',
    '',
    'vite v6.4.2 building for production…',
    'transforming modules: 128/128',
    'dist/index.html                 2.14 kB │ gzip:  0.92 kB',
    'dist/assets/index-B7cQd1Wm.js  184.62 kB │ gzip: 58.31 kB',
    '✓ built in 12.4s',
  ].join('\n');
  const typecheck = [
    '> sample-app@0.4.0-rc.1 typecheck',
    '> tsc --noEmit',
    '',
    "src/release/publish.ts:41:7 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
    "src/release/publish.ts:58:22 - error TS2345: Argument of type 'number' is not assignable to parameter of type 'ReleaseChannel'.",
    '',
    'Found 2 errors in 1 file.',
    ' ELIFECYCLE  Command failed with exit code 2.',
  ].join('\n');
  return {
    ...h01,
    snapshots: {
      ...h01.snapshots,
      [sessionId]: {
        messages: [],
        has_more: false,
        tasks: [
          {
            id: 'task_d03_test_suite',
            session_id: sessionId,
            kind: 'bash',
            description: pick(locale, 'sample-app test suite (watch)', 'sample-app 测试套件（watch）'),
            status: 'running',
            command: 'pnpm --filter sample-app test -- --watch',
            created_at: ts(9),
            started_at: ts(9),
            run_in_background: true,
            output_preview: running,
            output_bytes: 16_384,
          },
          {
            id: 'task_d03_docs_build',
            session_id: sessionId,
            kind: 'bash',
            description: pick(locale, 'docs preview build', '文档预览构建'),
            status: 'completed',
            command: 'pnpm --filter docs build',
            created_at: ts(34),
            started_at: ts(34),
            completed_at: ts(31),
            run_in_background: true,
            exit_code: 0,
            output_preview: build,
            output_bytes: 4_096,
          },
          {
            id: 'task_d03_typecheck',
            session_id: sessionId,
            kind: 'bash',
            description: pick(locale, 'workspace typecheck', '整个工作区类型检查'),
            status: 'failed',
            command: 'pnpm -r typecheck',
            created_at: ts(52),
            started_at: ts(52),
            completed_at: ts(49),
            run_in_background: true,
            exit_code: 2,
            stop_reason: 'exit code 2',
            output_preview: typecheck,
            output_bytes: 2_048,
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// D04 — folded tool steps + one expanded completion notification
// ---------------------------------------------------------------------------

/**
 * One settled session whose transcript shows both halves of "see everything":
 * three consecutive tool calls folded into a single Steps row, and the
 * background task's completion notification retained on the system lane. The
 * notification is the real `<notification … category="task">` envelope the
 * daemon injects, not a fictional inbox.
 */
export function buildD04(locale) {
  const base = quiet(locale);
  const sessionId = SESSION.release;
  const read = fid('call');
  const grep = fid('call');
  const test = fid('call');
  const notification = [
    '<notification id="n_d04_suite" category="task" type="task.completed" source_kind="background_task" source_id="task_d04_suite">',
    pick(locale, 'Title: Background command completed', 'Title: 后台命令已结束'),
    'pnpm test --filter sample-app — 42 passed in 18.4s',
    '</notification>',
  ].join('\n');
  return {
    ...base,
    snapshots: {
      ...base.snapshots,
      [sessionId]: {
        has_more: false,
        messages: [
          userMsg(
            sessionId,
            pick(
              locale,
              'Run the release checks in the background and keep drafting the changelog while they run.',
              '把发布检查放到后台运行，运行期间继续起草更新日志。',
            ),
            24,
          ),
          assistantMsg(
            sessionId,
            [
              { toolUse: { id: read, name: 'Read', input: { path: 'CHANGELOG.md' } } },
              { toolUse: { id: grep, name: 'Grep', input: { pattern: 'feat\\(' } } },
              { toolUse: { id: test, name: 'Bash', input: { command: 'pnpm test --filter sample-app', run_in_background: true } } },
            ],
            23,
          ),
          toolResultMsg(sessionId, read, pick(locale, 'Latest entry: 0.3.0.', '最新条目：0.3.0。'), 23),
          toolResultMsg(sessionId, grep, pick(locale, '6 feature commits to fold in.', '需并入 6 条 feature 提交。'), 23),
          toolResultMsg(
            sessionId,
            test,
            pick(locale, 'Started in the background as task_d04_suite.', '已在后台启动，任务 id 为 task_d04_suite。'),
            23,
          ),
          assistantMsg(
            sessionId,
            [
              pick(
                locale,
                'Changelog draft is updated for the six feature commits; the suite is running in the background.',
                '更新日志已按 6 条 feature 提交改好；测试套件正在后台运行。',
              ),
            ],
            22,
          ),
          originMsg(sessionId, notification, { kind: 'task', taskId: 'task_d04_suite' }, 9),
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// D05 — scheduled-task panel
// ---------------------------------------------------------------------------

/**
 * H01's workbench (so the rail that hosts the panel launcher is alive) plus
 * three scheduled plans: an enabled recurring plan, an enabled one-shot plan
 * and a paused plan, each with its next fire time and row actions. The rows are
 * served from the cron route; the still image shows what is scheduled, not that
 * a schedule already fired.
 */
export function buildD05(locale) {
  return {
    ...buildH01(locale),
    cronTasks: p2CronTasks(locale),
  };
}

// ---------------------------------------------------------------------------
// D06 / D07 — nb-search lanes and fetch chain
// ---------------------------------------------------------------------------

function nbSearchBase(locale) {
  const base = quiet(locale);
  return {
    ...base,
    config: {
      ...base.config,
      nb_search: p2NbSearchConfig(),
      nb_search_source: { reuse_local_config: false },
    },
    nbSearchCapabilities: {
      ...p2NbSearchCapabilities(),
      config_source: p2NbSearchSourceConfig(),
    },
    nbSearchTest: p2NbSearchTest(),
  };
}

/** `/settings/search?tab=search` — five selectable lanes with live readiness. */
export function buildD06(locale) {
  return nbSearchBase(locale);
}

/** `/settings/search?tab=fetch` — one saved three-step fallback chain. */
export function buildD07(locale) {
  return nbSearchBase(locale);
}

// ---------------------------------------------------------------------------
// D08 — video attachment preview
// ---------------------------------------------------------------------------

const RECORDING_PATH = 'C:/Projects/sample-app/shots/navigation-demo.mp4';
const ATTACHMENT_ID = 'att_d08_navigation_demo';

/**
 * One session, no subagents: the attached sample recording lands in the
 * transcript as the mediaPreview player, next to the question the operator
 * asked. The agent has only started inspecting the file — the image carries no
 * claim about how well a model understood the video.
 */
export function buildD08(locale) {
  const base = quiet(locale);
  const sessionId = SESSION.release;
  const recording = turn({
    turnId: 't1',
    ordinal: 1,
    prompt: pick(locale, 'Which step in this screen recording feels confusing?', '这段录屏里哪一步让人困惑？'),
    minutesAgo: 4,
    state: 'running',
    frames: [
      textFrame({
        frameId: 'd08-note',
        text: pick(locale, 'Reading the recording first.', '先看一下这段录屏。'),
      }),
      toolFrame({
        frameId: 'd08-read-media',
        toolCallId: 'call_d08_read_media',
        name: 'ReadMediaFile',
        input: { path: RECORDING_PATH },
        output: undefined,
        state: 'running',
      }),
    ],
  });
  recording.attachmentIds = [ATTACHMENT_ID];
  return {
    ...base,
    snapshots: {
      ...base.snapshots,
      [sessionId]: {
        messages: [],
        has_more: false,
        agent_transcripts: {
          main: {
            agent_id: 'main',
            has_more: false,
            // The turn's attachment is what the transcript's media layer
            // renders; it keeps the file name, size and MIME a real upload
            // carries.
            attachments: [
              {
                attachmentId: ATTACHMENT_ID,
                mediaType: 'video/mp4',
                name: 'navigation-demo.mp4',
                size: navigationDemoBytes().byteLength,
                source: { kind: 'url', url: navigationDemoDataUrl() },
              },
            ],
            items: [recording],
            prompts: [],
            meta: { activity: 'turn', agent: runningMeta({ turnId: 1 }) },
          },
        },
      },
    },
  };
}

export { ATTACHMENT_ID, RECORDING_PATH };
