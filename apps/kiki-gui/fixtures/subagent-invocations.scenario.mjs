import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_subagent_invocations';
const start = new Date(Date.now() - 120_000).toISOString();
const end = new Date(Date.now() - 30_000).toISOString();
const advisory = { version: 1, code: 'model_not_preferred', dimension: 'model', ruleSource: 'profile', ruleValues: ['fixture/preferred'], requestedValue: 'fixture/requested', effectiveValue: 'fixture/requested', valueSource: 'dispatch-explicit', message: '请求的模型不在此 Profile 的优选列表中；本次调用保留显式选择。' };
const tool = (id, name, input, output, agentId) => ({ kind: 'tool', frameId: `tool-${id}`, toolCallId: id, name, state: 'done', input, output, startedAt: start, endedAt: end, agentRefs: agentId === undefined ? undefined : [{ agentId, role: 'child' }] });
const turn = (frames) => ({ kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' }, prompt: '核对调用记录与嵌套任务的状态。', startedAt: start, endedAt: end, steps: [{ kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed', startedAt: start, endedAt: end, frames }] });
const task = (agentId, state, name, summary) => ({ taskId: `task-${agentId}`, kind: 'subagent', state, detached: true, agentId, name, subagentName: name, description: name, startedAt: start, endedAt: state === 'completed' ? end : undefined, outputTail: summary });

export default {
  sessions: [sessionRecord(SID, { title: 'Fixture: subagent invocations' })],
  snapshots: {
    [SID]: {
      messages: [], has_more: false,
      subagents: [
        { agent_id: 'agent-lead', label: '研究协调员', parent_agent_id: 'main', status: 'running', started_at: start },
        { agent_id: 'agent-done', label: '协议核查', parent_agent_id: 'agent-lead', status: 'completed', started_at: start, completed_at: end, output_preview: '已核对全部调用字段。没有遗漏。' },
        { agent_id: 'agent-live', label: '运行验证', parent_agent_id: 'agent-lead', status: 'running', started_at: start, description: '正在检查长会话分页与调用来源。' },
      ].map((entry) => ({ id: `task-${entry.agent_id}`, session_id: SID, kind: 'subagent', created_at: start, description: entry.label, ...entry })),
      agent_transcripts: {
        main: {
          agent_id: 'main', has_more: false,
          tasks: [task('agent-lead', 'running', '研究协调员', '')],
          items: [turn([
            tool('call-lead', 'AgentRun', { profile: 'explore', name: 'research', model_alias: 'fixture/requested', effort: 'high', background: true, description: '核查调用记录', prompt: '核对原始工具帧中的输入和输出。\n完整保留所有绑定建议，并报告字段来源。' }, `task_id: task-agent-lead\nagent_id: agent-lead\nactual_profile: explore\nstatus: running\nbinding_advisories: ${JSON.stringify([advisory])}\nbinding_advisory_count: 1\nbinding_advisory_first: ${JSON.stringify(advisory)}\n\n后台任务已登记。`, 'agent-lead'),
            tool('send-lead', 'AgentSend', { target: 'agent-lead', message: '请同时检查嵌套智能体。\n已完成的历史任务应显示为一行摘要，正在运行的任务保持展开。' }, JSON.stringify({ message_id: 'message-example', status: 'queued', deduplicated: false, target: { task_name: 'research', agent_id: 'agent-lead' } })),
          ])],
        },
        'agent-lead': {
          agent_id: 'agent-lead', has_more: false,
          tasks: [task('agent-done', 'completed', '协议核查', '已核对全部调用字段。没有遗漏。'), task('agent-live', 'running', '运行验证', '')],
          items: [turn([
            tool('call-done', 'AgentRun', { profile: 'explore', description: '字段核查', prompt: '检查所有调用字段。' }, 'task_id: task-agent-done\nagent_id: agent-done\nactual_profile: explore\nstatus: completed\n\n已核对全部调用字段。', 'agent-done'),
            tool('call-live', 'AgentRun', { profile: 'explore', description: '分页验证', prompt: '检查历史页与实时更新。', background: true }, 'task_id: task-agent-live\nagent_id: agent-live\nactual_profile: explore\nstatus: running', 'agent-live'),
          ])],
        },
        'agent-done': { agent_id: 'agent-done', has_more: false, items: [turn([{ kind: 'text', frameId: 'done-answer', role: 'assistant', text: '已核对全部调用字段。' }])] },
        'agent-live': { agent_id: 'agent-live', has_more: false, items: [] },
      },
    },
  },
};
