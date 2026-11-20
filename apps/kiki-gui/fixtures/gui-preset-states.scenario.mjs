/**
 * gui-preset-states — comprehensive preset state fixture for visual proof and
 * P0 send-stability + audio-playback rAF/MutationObserver flight-recorder tests.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assistantMsg,
  commitAssistant,
  sessionRecord,
  streamSteps,
  ts,
  turnEnd,
  turnStart,
  userMsg,
  workChanged,
} from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAV_B64 = readFileSync(join(HERE, 'media-bytes', 'voice.wav')).toString('base64');
const PNG_B64 = readFileSync(join(HERE, 'media-bytes', 'cover.png')).toString('base64');

const WS_MAIN = 'wd_preset_main_000000000001';
const WS_DOCS = 'wd_preset_docs_000000000002';
const WS_LABS = 'wd_preset_labs_000000000003';

const SID = 'session_preset_persona_audio';
const SID_DENSE = 'session_preset_dense_combined';
const SID_COLD = 'session_preset_cold_preparing';
const SID_MESH = 'session_preset_mesh_ssh';
const AUDIO_FILE_ID = 'preset_audio_wav_01';

const workspaces = [
  { id: WS_MAIN, root: 'C:/fixture/kiki-app', name: 'kiki-app', created_at: ts(5000), last_opened_at: ts(1), session_count: 35, pinned: true },
  { id: WS_DOCS, root: 'C:/fixture/docs-site', name: 'docs-site', created_at: ts(6000), last_opened_at: ts(20), session_count: 28, pinned: false },
  { id: WS_LABS, root: 'C:/fixture/audio-labs', name: 'audio-labs', created_at: ts(7000), last_opened_at: ts(40), session_count: 24, pinned: false },
];

const personas = [
  {
    definition: {
      id: 'nia',
      name: '大妮娅',
      title: '全栈搭档',
      job: '负责前端交互、音视频体验与回归验证。',
      modelAlias: 'fixture/kiki-pro',
      thinkingEffort: 'high',
      greeting: '在的，今天看哪一块？',
      memory: { shared: ['global', 'workspace'] },
      description: '你是大妮娅，直接简洁，先给结论和证据。',
    },
  },
  {
    definition: {
      id: 'xiao-you',
      name: '小柚',
      title: '发布协调',
      job: '盯版本与检查清单。',
      modelAlias: 'fixture/kiki-pro',
      thinkingEffort: 'medium',
      greeting: '版本清单准备好了。',
      memory: { shared: ['global'] },
      description: '你是小柚。',
    },
  },
];

// Build a scrollable 14-turn transcript with an audio attachment at the top
// and another audio attachment near the bottom so audio playback & open preview
// are immediately exercisable alongside realistic mid-session send scrolling.
const multiTurnMessages = [
  {
    id: 'msg_preset_audio_top',
    session_id: SID,
    role: 'user',
    content: [
      { type: 'text', text: '请听一下这段语音反馈并核对发送链路和音频缓存表现。' },
      { type: 'audio', source: { kind: 'file', file_id: AUDIO_FILE_ID }, name: 'voice-feedback.wav', mime: 'audio/wav' },
    ],
    created_at: ts(60),
  },
  assistantMsg(SID, [
    '已收到语音并完成首轮排查。\n\n主要涉及 `session_controller` 与 `use_stick_to_bottom` 的交互，以及 `useSessionMediaPlayback` 卸载回收授权的问题。',
  ], 59),
];

for (let i = 1; i <= 12; i += 1) {
  multiTurnMessages.push(
    userMsg(SID, `第 ${i} 轮排查记录：检查第 ${i} 段虚拟列表滚动高度与消息锚定偏移量，确认发消息不会闪屏或跳回顶部。`, 55 - i * 3),
    assistantMsg(SID, [
      `第 ${i} 轮确认完成。\n\n- 虚拟滚动行高测量稳定，未触发 \`data-phase="settling"\` 回退。\n- 缓存键 \`session_media_grant_${i}\` 复用正常，打开预览无需重新发起 POST 请求。\n- 下一步继续验证长列表和并发输入状态。`,
    ], 54 - i * 3),
  );
}

// Add a recent audio message near the bottom of the scroll viewport so it is
// immediately visible and clickable when landed at bottom.
multiTurnMessages.push({
  id: 'msg_preset_audio_recent',
  session_id: SID,
  role: 'user',
  content: [
    { type: 'text', text: '这是最新录制的复现音频，点击打开预览验证零闪烁复用：' },
    { type: 'audio', source: { kind: 'file', file_id: AUDIO_FILE_ID }, name: 'repro-voice.wav', mime: 'audio/wav' },
  ],
  created_at: ts(2),
});
multiTurnMessages.push(
  assistantMsg(SID, [
    '已就绪，相关标识符 `use_session_media_playback` 与 `ready_transcript_key` 保持完整。现在可以直接点开音频或发送新消息验证每一帧状态。',
  ], 1),
);

const extraSessions = Array.from({ length: 84 }, (_, idx) => {
  const ws = idx < 32 ? WS_MAIN : idx < 60 ? WS_DOCS : WS_LABS;
  const cwd = ws === WS_MAIN ? 'C:/fixture/kiki-app' : ws === WS_DOCS ? 'C:/fixture/docs-site' : 'C:/fixture/audio-labs';
  return sessionRecord(`session_preset_bulk_${String(idx + 1).padStart(3, '0')}`, {
    title: `Preset thread #${String(idx + 1).padStart(2, '0')} · ${ws === WS_MAIN ? 'UI floating & send stability' : ws === WS_DOCS ? 'Documentation sync' : 'Audio playback latency'}`,
    workspace_id: ws,
    metadata: { cwd },
    created_at: ts(200 + idx * 5),
    updated_at: ts(5 + idx * 4),
  });
});

const sshHosts = Array.from({ length: 14 }, (_, idx) => ({
  id: `host-${String(idx + 1).padStart(2, '0')}`,
  name: idx === 0 ? 'GPU Worker 01' : idx === 1 ? 'Build Runner 02' : `Compute Node ${String(idx + 1).padStart(2, '0')}`,
  hostname: `node-${idx + 1}.lab.example.test`,
  user: 'ubuntu',
  port: 22,
  roots: [`/srv/node-${idx + 1}`],
  description: `Cluster host ${idx + 1}`,
  agentAccess: 'offered',
}));

const tasks = [
  {
    id: 'task_running_01',
    session_id: SID,
    kind: 'bash',
    status: 'running',
    description: 'pnpm --filter @kiki/gui test --watch',
    command: 'pnpm --filter @kiki/gui test --watch',
    output_preview: 'Running visual preset assertions...',
    created_at: ts(3),
    updated_at: ts(1),
  },
  ...Array.from({ length: 5 }, (_, idx) => ({
    id: `task_settled_0${idx + 1}`,
    session_id: SID,
    kind: 'bash',
    status: 'completed',
    description: `Settled verification step #${idx + 1}`,
    command: `node scripts/step-${idx + 1}.mjs`,
    output_preview: `step ${idx + 1} completed`,
    created_at: ts(30 - idx * 4),
    updated_at: ts(29 - idx * 4),
  })),
];

const ANSWER_TEXT = '发送完成：整个发送过程中界面零闪屏、无 settling 回退、滚动位置保持稳定且无需刷新。';

const denseMessages = [
  userMsg(SID_DENSE, '密集组合态核验：同时开启队列条、批注弹层、图片附件、错误提示与 520 个子代理名册。', 12),
  assistantMsg(SID_DENSE, [
    '第一段核验正文：批注弹层必须通过 Portal 渲染在卡片外部，确保 5 点命中测试不被队列条或容器裁切遮挡。',
  ], 11),
  userMsg(SID_DENSE, '继续核对暗色窄屏与亮色宽屏的同框排版。', 6),
  assistantMsg(SID_DENSE, [
    '第二段核验正文：520 个子代理名册在右侧栏与会话状态中平滑虚拟化，且重复错误提示自动合并为单条单关闭图标。',
  ], 5),
];

const denseSubagents = Array.from({ length: 520 }, (_, idx) => {
  const running = idx < 3;
  const agentId = `sub_dense_${String(idx + 1).padStart(3, '0')}`;
  return {
    id: `task_${agentId}`,
    session_id: SID_DENSE,
    kind: 'subagent',
    status: running ? 'running' : 'completed',
    description: running ? `Streaming verification batch #${idx + 1}` : `Completed verification batch #${idx + 1}`,
    agent_id: agentId,
    parent_agent_id: 'main',
    label: running ? `live_worker_${idx + 1}` : `worker_${String(idx + 1).padStart(3, '0')}`,
    model: 'fixture/kiki-pro',
    thinking_effort: 'high',
    created_at: ts(600 - idx),
    started_at: ts(600 - idx),
    ...(running ? {} : { completed_at: ts(Math.max(1, 599 - idx)), output_preview: `Batch #${idx + 1} verified.` }),
    tool_call_count: (idx % 7) + 1,
    live: running,
  };
});

const coldMessages = [
  userMsg(SID_COLD, '冷开历史会话记录 1：用于验证从 cold/preparing 升级到 live/ready 发消息时滚动容器不卸载。', 40),
  assistantMsg(SID_COLD, ['冷开历史回复 1：已加载静态快照。'], 39),
  userMsg(SID_COLD, '冷开历史会话记录 2：继续补充上下文以确保列表高度足够。', 30),
  assistantMsg(SID_COLD, ['冷开历史回复 2：准备就绪，等待用户触发冷转热发送。'], 29),
];

const meshMessages = [
  userMsg(SID_MESH, '核验底部统一 SSH + Mesh 租约与端口隧道胶囊的展开布局与人工接管标记。', 10),
  assistantMsg(SID_MESH, [
    '已将 `GPU Worker 01`、远端节点 `Mac Studio`、人工接管中的 `Claude Seat` 与本地回环隧道 `127.0.0.1:5173 → 3000` 归入同一个外部状态胶囊，点击胶囊可向上展开核对。',
  ], 9),
];

export default {
  experimentalFlags: { native_ssh: true },
  workspaces,
  personas,
  searchHits: Array.from({ length: 65 }, (_, idx) => ({
    session_id: `session_preset_bulk_${String(idx + 1).padStart(2, '0')}`,
    workspace_id: WS_MAIN,
    session_title: `Preset thread #${String(idx + 1).padStart(2, '0')} · UI floating & virtualization`,
    role: 'assistant',
    snippet: `Preset hit #${idx + 1}: verified Base UI floating surface and virtualized quick switcher navigation.`,
    turn: idx + 1,
    agent_id: 'main',
    updated_at: ts(idx + 5),
  })),
  agentProfiles: [
    { name: 'agent', source: 'builtin', description: 'General-purpose built-in agent.', main: true, routes: [] },
    { name: 'frontend', source: 'user', description: 'UI implementation and visual verification.', main: true, routes: [] },
    { name: 'implementer', source: 'user', description: 'End-to-end engineering owner.', main: true, routes: [] },
  ],
  agentPanel: {
    context: 'live',
    owner: { profile: 'agent', agent_id: 'main' },
    available: true,
    profile: {
      name: 'agent',
      description: 'Fixture general-purpose agent.',
      source: 'builtin',
      model: 'fixture/kiki-pro',
      thinking_effort: 'high',
      profile_source: 'registered',
      subagent_policy: 'advisory',
    },
    tools: [
      { name: 'Read', source: 'builtin', state: 'on', description: 'Read files' },
      { name: 'Edit', source: 'builtin', state: 'on', description: 'Edit files' },
      { name: 'Bash', source: 'builtin', state: 'on', description: 'Run shell commands' },
    ],
    skills: [
      { name: 'my-little-frontend', description: 'Frontend craft & audit' },
    ],
    targets: [
      { name: 'explore', description: 'Locate files and symbols' },
    ],
  },
  ssh: {
    hosts: sshHosts,
    config: [],
    syncConfig: false,
    syncSource: 'home',
    status: { 'host-01': 'ready', 'host-02': 'idle' },
    session: {
      [SID]: ['host-01', 'host-02'],
      [SID_MESH]: ['host-01'],
    },
  },
  mesh: {
    sessions: {
      [SID_MESH]: {
        nodes: [
          {
            nodeId: 'node-mac-studio',
            label: 'Mac Studio',
            trustTier: 'trusted_personal',
            capabilities: ['execute', 'read', 'send', 'port_tunnel', 'takeover'],
            state: 'online',
            platform: 'darwin',
            pinnedAt: Date.now() - 120_000,
            createdBySession: false,
          },
        ],
        seats: [
          {
            seatId: 'seat-claude-01',
            nodeId: 'node-mac-studio',
            label: 'Claude Seat',
            state: 'running',
            pinnedAt: Date.now() - 90_000,
            updatedAt: Date.now() - 15_000,
            createdBySession: true,
          },
        ],
        workspaceCopies: [],
        portTunnels: [
          {
            tunnelId: 'tun-5173',
            nodeId: 'node-mac-studio',
            remoteHost: '127.0.0.1',
            remotePort: 3000,
            localHost: '127.0.0.1',
            localPort: 5173,
            healthy: true,
            createdAt: Date.now() - 60_000,
          },
        ],
      },
    },
    takeovers: {
      'seat-claude-01': {
        holder: 'human',
        epoch: 3,
        ttlMs: 300_000,
        reason: 'Live review',
      },
    },
  },
  mediaFiles: {
    [AUDIO_FILE_ID]: {
      base64: WAV_B64,
      mime: 'audio/wav',
      name: 'repro-voice.wav',
    },
    preset_img_01: {
      base64: PNG_B64,
      mime: 'image/png',
      name: 'shot-1.png',
    },
  },
  sessions: [
    sessionRecord(SID, {
      title: '大妮娅 · 长标题语音与发送稳定性回归测试验证会话',
      workspace_id: WS_MAIN,
      metadata: { cwd: 'C:/fixture/kiki-app' },
      agent_config: {
        model: 'fixture/kiki-pro',
        profile: 'agent',
        persona: { id: 'nia', name: '大妮娅' },
      },
      message_count: multiTurnMessages.length,
    }),
    sessionRecord(SID_DENSE, {
      title: '密集组合态回归：队列+批注+附件+520子代理',
      workspace_id: WS_MAIN,
      metadata: { cwd: 'C:/fixture/kiki-app' },
      agent_config: { model: 'fixture/kiki-pro', profile: 'agent' },
      message_count: denseMessages.length,
    }),
    sessionRecord(SID_COLD, {
      title: '冷开历史会话冷转热发送回归',
      workspace_id: WS_MAIN,
      metadata: { cwd: 'C:/fixture/kiki-app' },
      agent_config: { model: 'fixture/kiki-pro', profile: 'agent' },
      message_count: coldMessages.length,
    }),
    sessionRecord(SID_MESH, {
      title: '统一 SSH + Mesh 租约与端口隧道胶囊核验',
      workspace_id: WS_MAIN,
      metadata: { cwd: 'C:/fixture/kiki-app' },
      agent_config: { model: 'fixture/kiki-pro', profile: 'agent' },
      message_count: meshMessages.length,
    }),
    ...extraSessions,
  ],
  snapshots: {
    [SID]: {
      messages: multiTurnMessages,
      has_more: false,
      tasks,
    },
    [SID_DENSE]: {
      messages: denseMessages,
      has_more: false,
      tasks,
      subagents: denseSubagents,
      queued_prompts: [
        {
          prompt_id: 'prompt_dense_queued_01',
          user_message_id: 'um_dense_queued_01',
          status: 'queued',
          content: [{ type: 'text', text: '补充确认密集态下 QueueStrip 与批注弹层不遮挡' }],
          created_at: ts(1),
          queue_position: 0,
          append_timing: 'agent_idle',
          revision: 1,
        },
      ],
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [
            {
              kind: 'turn',
              turnId: 't_dense_1',
              ordinal: 1,
              state: 'completed',
              origin: { kind: 'user' },
              userMessageId: 'um_dense_1',
              assistantMessageId: 'am_dense_1',
              prompt: '密集组合态核验：同时开启队列条、批注弹层、图片附件、错误提示与 520 个子代理名册。',
              createdAt: ts(12),
              steps: [
                {
                  kind: 'step',
                  stepId: 't_dense_1.1',
                  turnId: 't_dense_1',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    {
                      kind: 'text',
                      frameId: 'f_dense_1',
                      role: 'assistant',
                      text: '第一段核验正文：批注弹层必须通过 Portal 渲染在卡片外部，确保 5 点命中测试不被队列条或容器裁切遮挡。',
                      part: {
                        partId: 'part_dense_1',
                        messageId: 'am_dense_1',
                        revision: 1,
                        provenance: { source: 'engine' },
                      },
                    },
                  ],
                },
              ],
            },
            {
              kind: 'turn',
              turnId: 't_dense_2',
              ordinal: 2,
              state: 'completed',
              origin: { kind: 'user' },
              userMessageId: 'um_dense_2',
              assistantMessageId: 'am_dense_2',
              prompt: '继续核对暗色窄屏与亮色宽屏的同框排版。',
              createdAt: ts(6),
              steps: [
                {
                  kind: 'step',
                  stepId: 't_dense_2.1',
                  turnId: 't_dense_2',
                  ordinal: 1,
                  state: 'completed',
                  frames: [
                    {
                      kind: 'text',
                      frameId: 'f_dense_2',
                      role: 'assistant',
                      text: '第二段核验正文：520 个子代理名册在右侧栏与会话状态中平滑虚拟化，且重复错误提示自动合并为单条单关闭图标。',
                      part: {
                        partId: 'part_dense_2',
                        messageId: 'am_dense_2',
                        revision: 1,
                        provenance: { source: 'engine' },
                      },
                    },
                  ],
                },
              ],
            },
          ],
          prompts: [
            {
              promptId: 'prompt_dense_queued_01',
              userMessageId: 'um_dense_queued_01',
              status: 'queued',
              text: '补充确认密集态下 QueueStrip 与批注弹层不遮挡',
              content: [{ type: 'text', text: '补充确认密集态下 QueueStrip 与批注弹层不遮挡' }],
              createdAt: ts(1),
              queuePosition: 0,
              appendTiming: 'agent_idle',
              revision: 1,
            },
          ],
        },
      },
    },
    [SID_COLD]: {
      epoch: 'cold:session_preset_cold_preparing',
      messages: coldMessages,
      has_more: false,
      tasks: [],
    },
    [SID_MESH]: {
      messages: meshMessages,
      has_more: false,
      tasks: [],
    },
  },
  onPrompt: (text, _sessionId) => {
    const promptText = String(text ?? '');
    if (promptText.includes('[cls-storm]')) {
      const frames = [
        turnStart(21),
        workChanged(true),
        { frame: { type: 'turn.step.started', payload: { turnId: 21, step: 1 } } },
        {
          delay: 40,
          frame: {
            type: 'tool.started',
            payload: {
              turnId: 21,
              toolCallId: 'call_storm_grep',
              name: 'Grep',
              input: { pattern: 'conversation-seat', path: 'apps/kiki-gui/src' },
            },
          },
        },
      ];
      for (let i = 1; i <= 10; i += 1) {
        const id = `storm_sub_${String(i).padStart(2, '0')}`;
        frames.push(
          {
            delay: 55,
            frame: {
              type: 'subagent.spawned',
              payload: {
                subagentId: id,
                subagentName: `worker_${String(i).padStart(2, '0')}`,
                parentToolCallId: `call_storm_sub_${i}`,
                description: `Live layout-shift stress worker #${i}`,
                runInBackground: true,
                model: 'fixture/kiki-pro',
                thinkingEffort: 'high',
              },
            },
          },
          { delay: 20, frame: { type: 'subagent.started', payload: { subagentId: id } } },
        );
      }
      for (let i = 1; i <= 4; i += 1) {
        const id = `storm_sub_${String(i).padStart(2, '0')}`;
        frames.push({
          delay: 45,
          frame: {
            type: 'subagent.completed',
            payload: { subagentId: id, resultSummary: `Worker #${i} verified zero CLS.` },
          },
        });
      }
      frames.push(
        {
          delay: 40,
          frame: {
            type: 'tool.ended',
            payload: { turnId: 21, toolCallId: 'call_storm_grep', name: 'Grep', ok: true, output: '3 matches' },
          },
        },
        ...streamSteps('assistant.delta', 21, '并发 10 个子代理与多行输入、附件上传及排队条切换期间，布局零抖动。', { per: 14, delay: 25 }),
        { delay: 80 },
        commitAssistant('并发 10 个子代理与多行输入、附件上传及排队条切换期间，布局零抖动。'),
        workChanged(false),
        turnEnd(21, 'completed'),
      );
      return frames;
    }
    const reply = `${ANSWER_TEXT} (echo: ${promptText.slice(0, 48)})`;
    return [
      turnStart(20),
      workChanged(true),
      { frame: { type: 'turn.step.started', payload: { turnId: 20, step: 1 } } },
      ...streamSteps('assistant.delta', 20, reply, { per: 16, delay: 20 }),
      { delay: 60 },
      commitAssistant(reply),
      workChanged(false),
      turnEnd(20, 'completed'),
    ];
  },
};
