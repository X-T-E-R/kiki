/**
 * agent-references — `kiki://agents/<profile>` references in user messages:
 *
 *   - turn 1 references three profiles in one message. `worker` was delegated
 *     (its task names the same ref, so the chip opens the child run);
 *     `reviewer` was referenced but the run never started (failed, no child);
 *     `planner` was only mentioned, never delegated.
 *   - a queued prompt references `worker` too: the parked message renders the
 *     same chip before it sends.
 *
 * The child transcripts give the delegated jump a real page to land on. All
 * four reference chips must be readable in zh and en, and the delegated chip
 * must jump to the right child.
 */

import { fid, sessionRecord, ts } from './helpers.mjs';

const SID = 'session_fixture_agent_references';

const MESSAGE_ID = 'um_fx_ar_delegate';

const REFS = [
  { refId: `ar:${MESSAGE_ID}:worker`, profile: 'worker', executor: 'native', configuration: 'native', label: 'worker' },
  { refId: `ar:${MESSAGE_ID}:reviewer`, profile: 'reviewer', executor: 'native', configuration: 'native', label: 'reviewer' },
  { refId: `ar:${MESSAGE_ID}:planner`, profile: 'planner', executor: 'native', configuration: 'native', label: 'planner' },
  { refId: `ar:${MESSAGE_ID}:helper`, profile: 'helper', executor: 'claude-code', configuration: 'profile', label: 'helper' },
];

const PROMPT_TEXT = [
  '把这几件事分出去:',
  'kiki://agents/worker 去扫一遍 transcript 投影,',
  'kiki://agents/reviewer 复核我刚才的改动,',
  'kiki://agents/planner 先帮我排个计划,',
  'kiki://agents/helper 顺手看看 fixtures。',
].join('\n');

function refTurn(turnId, minutesAgo) {
  return {
    kind: 'turn',
    turnId,
    ordinal: Number(turnId),
    state: 'completed',
    origin: { kind: 'user' },
    startedAt: ts(minutesAgo),
    endedAt: ts(minutesAgo - 1),
    steps: [
      {
        kind: 'step',
        stepId: `${turnId}.1`,
        turnId,
        ordinal: 1,
        state: 'completed',
        startedAt: ts(minutesAgo),
        endedAt: ts(minutesAgo - 1),
        frames: [
          {
            kind: 'text',
            frameId: `${turnId}-user`,
            role: 'user',
            text: PROMPT_TEXT,
            delivery: { deliveryId: `d-${turnId}`, messageId: MESSAGE_ID, origin: 'user' },
            origin: { kind: 'user', agentRefs: REFS },
          },
          { kind: 'text', frameId: `${turnId}-assistant`, role: 'assistant', text: '好,我把 worker 分出去了,reviewer 这次没起来,planner 还没排。' },
        ],
      },
    ],
  };
}

function childTranscript(agentId, prompt, answer) {
  return {
    agent_id: agentId,
    has_more: false,
    items: [
      {
        kind: 'turn',
        turnId: '1',
        ordinal: 1,
        state: 'completed',
        origin: { kind: 'user' },
        prompt,
        startedAt: ts(38),
        endedAt: ts(37),
        steps: [
          {
            kind: 'step',
            stepId: '1.1',
            turnId: '1',
            ordinal: 1,
            state: 'completed',
            startedAt: ts(38),
            endedAt: ts(37),
            frames: [{ kind: 'text', frameId: `${agentId}-answer`, role: 'assistant', text: answer }],
          },
        ],
      },
    ],
  };
}

export default {
  // The executor catalog the chip reads the external engine's human label
  // from — the same source the composer's engine badge uses.
  executors: [
    { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
    { id: 'claude-code', label: 'Claude Code', protocol: 'claude-acp', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
  ],
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'worker', source: 'builtin', description: 'Bounded execution agent.', main: false, routes: [] },
    { name: 'reviewer', source: 'builtin', description: 'Review agent.', main: false, routes: [] },
    { name: 'planner', source: 'builtin', description: 'Planning agent.', main: false, routes: [] },
    { name: 'helper', source: 'builtin', description: 'External-engine helper agent.', main: false, routes: [] },
  ],
  sessions: [sessionRecord(SID, { title: 'Fixture: agent references' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      subagents: [
        { id: 'task-agent-worker', session_id: SID, kind: 'subagent', agent_id: 'agent-worker', label: 'worker', parent_agent_id: 'main', status: 'completed', tool_call_count: 3, description: '扫一遍 transcript 投影', output_preview: '投影扫完了。', created_at: ts(38), started_at: ts(38), completed_at: ts(37) },
      ],
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [refTurn('1', 40)],
          // The parked prompt references `worker` too: the chip must render in
          // the queue strip before the prompt sends.
          prompts: [
            {
              promptId: 'prompt_fx_ar_queued',
              userMessageId: 'um_fx_ar_queued',
              status: 'queued',
              content: [{ type: 'text', text: '发出去之后让 kiki://agents/worker 接着扫一遍 fixtures。' }],
              createdAt: ts(6),
              queuePosition: 0,
              appendTiming: 'agent_idle',
              revision: 1,
            },
          ],
          tasks: [
            // Delegated, and run twice: the most recent run is the jump target,
            // the earlier one stays in the chip's run menu.
            {
              taskId: 'task-agent-worker',
              kind: 'subagent',
              agentId: 'agent-worker',
              name: 'worker',
              description: '扫一遍 transcript 投影',
              state: 'completed',
              detached: true,
              outputTail: '投影扫完了。',
              resultSummary: '投影扫完了。',
              sourceRef: { ...REFS[0], messageId: MESSAGE_ID },
              startedAt: ts(38),
              endedAt: ts(37),
            },
            {
              taskId: 'task-agent-worker-earlier',
              kind: 'subagent',
              agentId: 'agent-worker-earlier',
              name: 'worker',
              description: '先扫一半 transcript 投影',
              state: 'completed',
              detached: true,
              outputTail: '扫了一半。',
              resultSummary: '扫了一半。',
              sourceRef: { ...REFS[0], messageId: MESSAGE_ID },
              startedAt: ts(50),
              endedAt: ts(49),
            },
            // Rejected: the run never started a child (failed, no agent id).
            {
              taskId: 'task-agent-reviewer',
              kind: 'subagent',
              name: 'reviewer',
              description: '复核我刚才的改动',
              state: 'failed',
              detached: true,
              outputTail: '',
              error: 'model request failed: 402 quota exhausted',
              sourceRef: { ...REFS[1], messageId: MESSAGE_ID },
              startedAt: ts(38),
              endedAt: ts(37),
            },
            // planner is referenced but never delegated: no task names its ref.
          ],
        },
        'agent-worker': childTranscript('agent-worker', '扫一遍 transcript 投影', '投影扫完了:排序在投影层,分页只窗口化 items。'),
        'agent-worker-earlier': childTranscript('agent-worker-earlier', '先扫一半 transcript 投影', '扫了一半:marker 排序在投影层。'),
      },
    },
  },
};
