/**
 * gui-slice — one resting session that exercises the transcript/rail slice:
 *
 *   - turn 1: a LONG user prompt (forces the collapsible bubble) followed by
 *     assistant prose, a four-call tool run (group; one failing Bash so the
 *     group auto-expands on error), and an AgentRun call carrying two
 *     agentRefs (canonical child ids) for the detail-jump proof.
 *   - a pile of consecutive agent markers (goal / plan.enter / plan.exit /
 *     swarm) between turns: the compact-history grouping target.
 *   - taskrefs for four child agents in a row: one completed, one failed
 *     (error visible), two still running (detached → background cards) — the
 *     dual-form subagent card matrix, plus a completed parent
 *     (agent-research) whose own child (agent-grand) is still running, which
 *     must NOT inflate the parent's card.
 *   - interactions: one approved approval + one answered question (terminal
 *     facts stay inline, compact) and one PENDING approval (stays a full,
     * independent card).
 *   - turn 2: a short follow-up so history groups never span a user message.
 *
 * Child agent transcripts give the agent pages and the rail's deep children
 * tree real content. The media session below covers the first-open overlap
 * path (long bubble + image + tool result image).
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_gui_slice';
const MEDIA_SID = 'session_fixture_gui_slice_media';

const LONG_PROMPT = [
  '帮我梳理这个仓库里 transcript 投影的完整链路，并且解释每一层的职责边界。',
  '我现在的理解是:kap-server 把 agent-core-v2 的事件聚合成 transcript items,GUI 通过 subscribe_v2 订阅,前端再投影成 block 列表。但我不清楚 marker、taskref、interaction 这三类实体在时间线上的排序规则,也不清楚分页时 hasMoreOlder 和游标是怎么配合的。',
  '另外我发现一个现象:首次打开一个很长的会话时,我的长消息气泡会和下面的 assistant 回复、工具卡片重叠在一起;切换到子代理页面时,块与块之间又会出现很大的空白。请帮我确认这是测高的问题还是锚点恢复的问题,并给出修复建议。',
  '如果涉及到虚拟滚动的 estimateSize、measureElement、scrollAdjustments 这些机制,请逐个解释它们在 prepend、append、reset 三种场景下的行为,不要只给一个笼统的结论。',
  '最后请把结论整理成一份可以交给前端工程师直接执行的清单。',
].join('\n\n');

const IMG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" rx="10" fill="#1c1917"/>
  <text x="20" y="40" font-family="monospace" font-size="14" fill="#f3e9d8">overlap repro</text>
  <rect x="20" y="60" width="130" height="90" rx="8" fill="#b3541e"/>
  <rect x="166" y="60" width="130" height="90" rx="8" fill="#8a9a5b"/>
</svg>`;
const IMG_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(IMG_SVG, 'utf8').toString('base64')}`;

function turnItem(turnId, prompt, frames, minutesAgo, state = 'completed') {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state,
    origin: { kind: 'user' },
    prompt,
    startedAt: ts(minutesAgo),
    endedAt: state === 'completed' ? ts(minutesAgo - 1) : undefined,
    steps: [
      {
        kind: 'step',
        stepId: `${turnId}.1`,
        turnId,
        ordinal: 1,
        state,
        startedAt: ts(minutesAgo),
        endedAt: state === 'completed' ? ts(minutesAgo - 1) : undefined,
        frames,
      },
    ],
  };
}

function subagentTask(id, name, state, overrides = {}) {
  return {
    taskId: `task-${id}`,
    kind: 'subagent',
    agentId: id,
    name,
    description: overrides.description,
    state,
    stateReason: overrides.stateReason,
    detached: true,
    outputTail: overrides.outputTail ?? '',
    resultSummary: overrides.resultSummary,
    error: overrides.error,
    startedAt: ts(40),
    endedAt: state === 'running' ? undefined : ts(30),
  };
}

function taskref(id, minutesAgo) {
  return { kind: 'taskref', refId: `taskref-${id}`, taskId: `task-${id}`, at: ts(minutesAgo) };
}

function childTranscript(agentId, prompt, frames, state = 'completed') {
  return {
    agent_id: agentId,
    has_more: false,
    items: [turnItem('1', prompt, frames, 35, state)],
  };
}

export default {
  // Two main profiles so the profile-switch retention walker has a target.
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'reviewer', source: 'builtin', description: 'Review-focused built-in agent.', main: true, routes: [] },
  ],
  // Workspace file index for the `@` mention picker (composer chip proof).
  fsEntries: [
    { path: 'board.svg', name: 'board.svg', kind: 'file' },
    { path: 'notes.md', name: 'notes.md', kind: 'file' },
  ],
  sessions: [
    sessionRecord(SID, { title: 'Fixture: gui slice timeline' }),
    sessionRecord(MEDIA_SID, { title: 'Fixture: gui slice media' }),
  ],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      // Roster with parent links: research (child of main, completed) spawned
      // grand (still running); writer failed; bg running; sleeper carries the
      // real suspended wire shape (status 'running' + subagent_phase
      // 'suspended', matching the session snapshot subagents list).
      // Note: subagent tasks are admitted detached, so the tree resolves
      // running subagents as 'background' — full cards by design. The
      // subagent_phase overlay only lands on live sources whose status is
      // 'unknown' (forest.ts overlayLiveSourcesWithSnapshotSubagents), so a
      // subagent with a running transcript task still resolves 'background';
      // the suspended > task-background specificity only fires when a roster
      // or live slot itself carries 'suspended' (agentTree.test.ts covers
      // that direction).
      subagents: [
        { agent_id: 'agent-research', label: 'Researcher', parent_agent_id: 'main', status: 'completed', tool_call_count: 7, description: 'Map the transcript projection pipeline', output_preview: 'Projection map delivered.', started_at: ts(42), completed_at: ts(30) },
        { agent_id: 'agent-writer', label: 'Writer', parent_agent_id: 'main', status: 'failed', tool_call_count: 2, description: 'Draft the handoff note', output_preview: '', started_at: ts(41), completed_at: ts(31) },
        { agent_id: 'agent-sleeper', label: 'Sleeper', parent_agent_id: 'main', status: 'running', subagent_phase: 'suspended', description: 'Wait for the vendor reply', started_at: ts(40) },
        { agent_id: 'agent-bg', label: 'Indexer', parent_agent_id: 'main', status: 'running', description: 'Rebuild the search index in the background', started_at: ts(39) },
        { agent_id: 'agent-grand', label: 'Verifier', parent_agent_id: 'agent-research', status: 'running', description: 'Verify every claim in the projection map against the actual source: check that marker ordering happens in the projection layer rather than the transport, that pagination only windows the item list, that interactions resolve through the canonical op path, and that the virtual scroller estimates are replaced by real measurements on mount. Report each discrepancy with file and line references so the frontend engineer can act without re-reading the whole pipeline.', started_at: ts(38) },
      ],
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            turnItem('1', LONG_PROMPT, [
              { kind: 'text', frameId: 't1-intro', role: 'assistant', text: '先把链路拆开:服务端投影、传输、前端投影三层。我查几个关键文件。' },
              { kind: 'tool', frameId: 'tool-read-proj', toolCallId: 'read-proj', name: 'Read', state: 'done', input: { path: 'packages/session-core/src/session/transcript/project.ts' }, output: 'project.ts: markers become neutral notices; taskrefs admit runs.' },
              { kind: 'tool', frameId: 'tool-grep-forest', toolCallId: 'grep-forest', name: 'Grep', state: 'done', input: { pattern: 'toolCallCountKnown' }, output: 'agentTree.ts:63\nselectors.ts:206' },
              { kind: 'tool', frameId: 'tool-bash-fail', toolCallId: 'bash-fail', name: 'Bash', state: 'error', input: { command: 'pnpm test --filter transcript' }, output: { message: '2 snapshots obsolete in transcript.test.ts' } },
              {
                kind: 'tool',
                frameId: 'tool-agentrun',
                toolCallId: 'agentrun-1',
                name: 'AgentRun',
                state: 'done',
                input: { description: 'Map the transcript projection pipeline' },
                agentRefs: [
                  { agentId: 'agent-research', role: 'child' },
                  { agentId: 'agent-writer', role: 'child' },
                ],
              },
              { kind: 'text', frameId: 't1-outro', role: 'assistant', text: 'Read 与 Grep 都确认:排序在投影层完成,分页只影响窗口。Bash 那次失败是快照过期,不影响结论。' },
            ], 45),
            // Consecutive marker pile — the compact-history grouping target.
            { kind: 'marker', markerId: 'm-goal-1', marker: 'goal', at: ts(44) },
            { kind: 'marker', markerId: 'm-plan-enter-1', marker: 'plan.enter', at: ts(44) },
            { kind: 'marker', markerId: 'm-plan-exit-1', marker: 'plan.exit', at: ts(43) },
            { kind: 'marker', markerId: 'm-swarm-1', marker: 'swarm', at: ts(43) },
            // Subagent taskrefs in a row: compact bars (failed stays visible).
            taskref('agent-research', 42),
            taskref('agent-writer', 41),
            taskref('agent-sleeper', 40),
            taskref('agent-bg', 39),
            turnItem('2', '结论先给我一句话版本。', [
              { kind: 'text', frameId: 't2-answer', role: 'assistant', text: '一句话:重叠与空白都来自同一次测高窗口里的估算值没有及时被真实高度替换。' },
            ], 20),
          ],
          tasks: [
            subagentTask('agent-research', 'Researcher', 'completed', { description: 'Map the transcript projection pipeline', resultSummary: 'Projection map delivered.', outputTail: 'Projection map delivered.' }),
            subagentTask('agent-writer', 'Writer', 'failed', { description: 'Draft the handoff note', error: 'model request failed: 402 quota exhausted' }),
            subagentTask('agent-sleeper', 'Sleeper', 'running', { description: 'Wait for the vendor reply', stateReason: 'subagent.suspended: waiting for the vendor reply' }),
            subagentTask('agent-bg', 'Indexer', 'running', { description: 'Rebuild the search index in the background' }),
          ],
          interactions: [
            {
              interactionId: 'approval-resolved-1',
              interactionKind: 'approval',
              toolCallId: 'bash-fail',
              state: 'approved',
              request: {
                turnId: 1,
                toolCallId: 'bash-fail',
                toolName: 'Bash',
                action: 'Running: pnpm test --filter transcript',
                display: { kind: 'command', command: 'pnpm test --filter transcript' },
                createdAt: ts(44),
                expiresAt: ts(-23 * 60),
              },
            },
            {
              interactionId: 'question-resolved-1',
              interactionKind: 'question',
              state: 'answered',
              request: {
                turnId: 1,
                questions: [{ question: '要深入到 measureElement 的源码层吗?', options: [{ label: '要' }, { label: '不用' }] }],
                createdAt: ts(43),
              },
            },
            {
              interactionId: 'approval-pending-1',
              interactionKind: 'approval',
              toolCallId: 'call-pending',
              state: 'pending',
              request: {
                turnId: 2,
                toolCallId: 'call-pending',
                toolName: 'Bash',
                action: 'Running: pnpm build',
                display: { kind: 'command', command: 'pnpm build' },
                createdAt: ts(19),
                expiresAt: ts(-23 * 60),
              },
            },
          ],
        },
        'agent-research': (() => {
          // The parent's own transcript carries the spawn: a taskref matching
          // a subagent task admits the grandchild block with parentAgentId
          // pointing at agent-research (this is what links grand under
          // research in the forest and the rail subtree).
          const transcript = childTranscript('agent-research', 'Map the transcript projection pipeline.', [
            { kind: 'tool', frameId: 'research-grep', toolCallId: 'research-grep', name: 'Grep', state: 'done', input: { pattern: 'markerToBlock' }, output: 'project.ts:455' },
            { kind: 'text', frameId: 'research-report', role: 'assistant', text: 'Pipeline mapped: server projection, transport, GUI projection.' },
          ]);
          transcript.items.push(taskref('agent-grand', 34));
          transcript.tasks = [
            subagentTask('agent-grand', 'Verifier', 'running', { description: 'Verify every claim in the projection map against the actual source.' }),
          ];
          return transcript;
        })(),
        'agent-grand': childTranscript('agent-grand', 'Verify the projection claims.', [
          { kind: 'tool', frameId: 'grand-read', toolCallId: 'grand-read', name: 'Read', state: 'running', input: { path: 'packages/session-core/src/session/transcript/project.ts' } },
        ], 'running'),
        // The sleeper's own transcript reports the awaiting_approval phase.
        // Once the GUI loads it (visiting the agent page), the roster-slot
        // 'suspended' status outranks the detached task's background
        // (agentTree activeStatusSpecificity) and the card compacts.
        'agent-sleeper': {
          agent_id: 'agent-sleeper',
          has_more: false,
          items: [],
          tasks: [],
          interactions: [],
          meta: { agent: { phase: { kind: 'awaiting_approval', turnId: 1, since: Date.parse(ts(40)) } } },
        },
      },
    },
    [MEDIA_SID]: {
      has_more: false,
      messages: [
        {
          id: fid('msg'),
          session_id: MEDIA_SID,
          role: 'user',
          content: [
            { type: 'text', text: `${LONG_PROMPT}\n\n截图在这里:` },
            { type: 'image', source: { kind: 'url', url: IMG_DATA_URL } },
          ],
          created_at: ts(6),
        },
        {
          id: fid('msg'),
          session_id: MEDIA_SID,
          role: 'assistant',
          content: [
            { type: 'text', text: '收到长文本和截图,先读图再回答。' },
            { type: 'tool_use', tool_call_id: 'call_media_slice', tool_name: 'ReadMediaFile', input: { path: 'C:/fixture/workshop/shots/board.svg' } },
          ],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: MEDIA_SID,
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              tool_call_id: 'call_media_slice',
              output: [
                { type: 'text', text: '<image path="C:/fixture/workshop/shots/board.svg">' },
                { type: 'image_url', imageUrl: { url: IMG_DATA_URL } },
                { type: 'text', text: '</image>' },
              ],
            },
          ],
          created_at: ts(5),
        },
        {
          id: fid('msg'),
          session_id: MEDIA_SID,
          role: 'user',
          content: [{ type: 'text', text: '图读完了吗?结论是什么?' }],
          created_at: ts(4),
        },
        {
          id: fid('msg'),
          session_id: MEDIA_SID,
          role: 'assistant',
          content: [{ type: 'text', text: '图读完了:首屏重叠来自估算高度未及时替换。' }],
          created_at: ts(4),
        },
      ],
    },
  },
};
