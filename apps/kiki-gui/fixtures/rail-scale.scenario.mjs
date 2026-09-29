/**
 * rail-scale — the inspector at fleet size, plus an idle session.
 *
 * "Fixture: agent fleet" runs 66 subagents in three levels under main:
 * 8 leads, 40 workers under them, 18 probes under some workers, in every
 * state (running, waiting on the user, failed, completed, cancelled). Two
 * level-2 workers are parked on approvals; both surface in main's Needs you
 * with their trail and can be decided in place. "Fixture: idle overview" has
 * no agents and no running turn: the overview alone has to carry the rail.
 *
 * Fixture-server data only (see helpers.mjs, fixture-transcript.mjs).
 */

import { sessionRecord, ts } from './helpers.mjs';

const FLEET = 'session_fixture_rail_fleet';
const IDLE = 'session_fixture_rail_idle';
const MODEL = 'fixture/kiki-pro';

const LEADS = [
  { key: 'docs', label: 'Docs lead', task: 'Map every page that mentions the 0.4 API' },
  { key: 'api', label: 'API lead', task: 'Audit the public API surface for breaking changes' },
  { key: 'tests', label: 'Test lead', task: 'Run the suites and bisect regressions' },
  { key: 'perf', label: 'Perf lead', task: 'Profile the cold start on three machines' },
  { key: 'i18n', label: 'Locale lead', task: 'Check string coverage for every locale' },
  { key: 'deps', label: 'Deps lead', task: 'Review dependency updates since 0.3' },
  { key: 'a11y', label: 'Access lead', task: 'Keyboard and screen-reader pass on the new flows' },
  { key: 'release', label: 'Release lead', task: 'Draft notes and stage the tag' },
];

const WORKER_TASKS = [
  'Read the module and list exported symbols',
  'Compare against the 0.3 snapshot',
  'Run the focused test file',
  'Collect the failing cases',
  'Summarize findings for the lead',
];

const MODELS = ['kimi-code/k3', 'deepseek-v4-flash', 'glm-5.3-flash', 'claude-fable'];
const EFFORTS = ['max', 'high', 'medium'];

/** Deterministic status spread; `waiting` rows get their approvals below. */
function statusFor(index) {
  const cycle = ['completed', 'running', 'completed', 'completed', 'running', 'failed', 'completed', 'cancelled'];
  return cycle[index % cycle.length];
}

const rows = [];
let serial = 0;
function add({ id, parent, label, task, status, minutesAgo, tools }) {
  serial += 1;
  rows.push({
    id,
    parent,
    label,
    task,
    status,
    minutesAgo,
    tools,
    model: MODELS[serial % MODELS.length],
    effort: EFFORTS[serial % EFFORTS.length],
  });
}

LEADS.forEach((lead, leadIndex) => {
  const leadId = `agent-${lead.key}`;
  // Two leads are still coordinating; the rest reported back.
  add({ id: leadId, parent: 'main', label: lead.label, task: lead.task, status: leadIndex < 2 ? 'running' : leadIndex === 5 ? 'failed' : 'completed', minutesAgo: 40 - leadIndex, tools: 12 + leadIndex });
  for (let w = 0; w < 5; w += 1) {
    const workerId = `${leadId}-w${w + 1}`;
    add({ id: workerId, parent: leadId, label: `${lead.label.split(' ')[0]} worker ${w + 1}`, task: WORKER_TASKS[w], status: statusFor(leadIndex * 5 + w), minutesAgo: 30 - w, tools: 3 + w });
    // Probes under the first two workers of the first five leads (level 3).
    if (leadIndex < 5 && w < 2) {
      for (let p = 0; p < (w === 0 ? 2 : 1) + (leadIndex === 0 ? 1 : 0); p += 1) {
        add({ id: `${workerId}-p${p + 1}`, parent: workerId, label: `Probe ${leadIndex + 1}.${w + 1}.${p + 1}`, task: 'Grep for call sites and report counts', status: p === 0 && w === 0 ? 'running' : 'completed', minutesAgo: 12 - p, tools: 2 + p });
      }
    }
  }
});

// The two level-2 agents waiting on the user.
const WAITING = [
  { agent: 'agent-api-w2', approval: 'approval_fleet_api', tool: 'Bash', command: 'git diff v0.3.0 -- src/public-api.ts', action: 'Run: git diff v0.3.0 -- src/public-api.ts' },
  { agent: 'agent-tests-w3', approval: 'approval_fleet_tests', tool: 'Write', path: 'test/regressions/cold-start.test.ts', action: 'Write test/regressions/cold-start.test.ts' },
];
for (const wait of WAITING) {
  const row = rows.find((entry) => entry.id === wait.agent);
  row.status = 'suspended';
}

const SUMMARY = {
  completed: 'Done; 3 findings written to the lead.',
  cancelled: 'Stopped by its lead before finishing.',
};
const ERRORS = [
  'Test runner exited with code 1 after 42 passed, 3 failed.',
  'Could not reach the registry: request timed out after 30s.',
];

function phaseFor(status, turnId) {
  switch (status) {
    case 'running':
      return { kind: 'running', turnId, step: 1, stepId: `t${turnId}.1`, since: 0 };
    case 'suspended':
      return { kind: 'awaiting_approval', turnId, since: 0 };
    case 'failed':
      return { kind: 'ended', turnId, reason: 'failed', at: 0 };
    case 'cancelled':
      return { kind: 'interrupted', turnId, reason: 'aborted', at: 0 };
    default:
      return { kind: 'ended', turnId, reason: 'completed', at: 0 };
  }
}

const roster = rows.map((row, index) => ({
  id: `task_${row.id}`,
  session_id: FLEET,
  kind: 'subagent',
  status: row.status === 'suspended' ? 'running' : row.status,
  subagent_phase: row.status === 'suspended' ? 'suspended' : undefined,
  description: row.task,
  agent_id: row.id,
  parent_agent_id: row.parent,
  label: row.label,
  model: row.model,
  thinking_effort: row.effort,
  created_at: ts(row.minutesAgo + 1),
  started_at: ts(row.minutesAgo),
  ...(row.status === 'completed' || row.status === 'cancelled' || row.status === 'failed'
    ? { completed_at: ts(Math.max(1, row.minutesAgo - 4)) }
    : {}),
  ...(row.status === 'completed' || row.status === 'cancelled' ? { output_preview: SUMMARY[row.status] } : {}),
  ...(row.status === 'failed' ? { stop_reason: ERRORS[index % ERRORS.length] } : {}),
  tool_call_count: row.tools,
  live: true,
}));

function childTranscript(row) {
  const wait = WAITING.find((entry) => entry.agent === row.id);
  const display = wait === undefined ? undefined : wait.command !== undefined
    ? { kind: 'command', command: wait.command }
    : { kind: 'file_io', operation: 'write', path: wait.path };
  return {
    agent_id: row.id,
    has_more: false,
    tool_call_count: row.tools,
    items: wait === undefined ? [] : [{
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' }, prompt: row.task,
      startedAt: ts(row.minutesAgo),
      steps: [{
        kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running', startedAt: ts(row.minutesAgo),
        frames: [{ kind: 'tool', frameId: `tool-${wait.approval}`, toolCallId: `call-${wait.approval}`, name: wait.tool, state: 'running', input: {}, display }],
      }],
    }],
    interactions: wait === undefined ? [] : [{
      interactionId: wait.approval,
      interactionKind: 'approval',
      toolCallId: `call-${wait.approval}`,
      origin: { agentId: row.id },
      state: 'pending',
      request: { turnId: 1, toolCallId: `call-${wait.approval}`, toolName: wait.tool, action: wait.action, display, createdAt: ts(3), expiresAt: ts(-600) },
    }],
    meta: {
      activity: row.status === 'running' || row.status === 'suspended' ? 'turn' : 'idle',
      agent: {
        model: row.model,
        thinkingEffort: row.effort,
        permission: 'manual',
        contextTokens: 8_000 + row.tools * 1_300,
        maxContextTokens: 262_144,
        phase: phaseFor(row.status, 1),
      },
    },
  };
}

const pendingApprovals = WAITING.map((wait) => ({
  approval_id: wait.approval,
  agentId: wait.agent,
  agent_id: wait.agent,
  session_id: FLEET,
  turn_id: 1,
  tool_call_id: `call-${wait.approval}`,
  tool_name: wait.tool,
  action: wait.action,
  tool_input_display: wait.command !== undefined ? { kind: 'command', command: wait.command } : { kind: 'file_io', operation: 'write', path: wait.path },
  created_at: ts(3),
  expires_at: ts(-600),
}));

function metricsRow({ input, output, cacheRead, contextTokens, cost, compactions = 0 }) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    totalTokens: input + output,
    totalCostUsd: cost,
    contextTokens,
    contextLimit: 262_144,
    compactionCount: compactions,
    usageSource: 'live',
  };
}

const metrics = {
  main: metricsRow({ input: 412_000, output: 38_600, cacheRead: 331_000, contextTokens: 148_300, cost: 3.86, compactions: 2 }),
};
rows.forEach((row, index) => {
  const input = 14_000 + (index % 9) * 3_100;
  metrics[row.id] = metricsRow({ input, output: 1_800 + (index % 5) * 700, cacheRead: Math.round(input * 0.62), contextTokens: 8_000 + row.tools * 1_300, cost: 0.04 + (index % 7) * 0.03 });
});

const TOOLS = [
  ['Read', 'filesystem'], ['Grep', 'filesystem'], ['Glob', 'filesystem'], ['Edit', 'filesystem'], ['Write', 'filesystem'],
  ['Bash', 'shell'], ['AgentRun', 'orchestration'], ['TaskList', 'orchestration'], ['WebSearch', 'web'], ['FetchURL', 'web'],
  ['TodoList', 'planning'],
].map(([name, category]) => ({ name, source: 'builtin', category, state: 'enabled' }));
const EXTENSION_TOOLS = [
  { name: 'mcp__github__search_issues', source: 'mcp', category: 'mcp', state: 'enabled' },
  { name: 'mcp__github__create_pr', source: 'mcp', category: 'mcp', state: 'approval-required' },
  { name: 'mcp__linear__list_issues', source: 'mcp', category: 'mcp', state: 'enabled' },
  { name: 'mcp__figma__get_frame', source: 'mcp', category: 'mcp', state: 'disconnected' },
  { name: 'plugin__release_kit__stage_tag', source: 'plugin', category: 'plugin', state: 'enabled' },
];

const agentPanel = {
  context: 'live',
  live: true,
  owner: { profile: 'agent', agent_id: 'main' },
  available: true,
  profile: {
    name: 'agent',
    description: 'Coordinates the release and routes each role to a model.',
    source: 'builtin',
    model: MODEL,
    thinking_effort: 'high',
    profile_source: 'registered',
    subagent_policy: 'advisory',
    tools: TOOLS.map((tool) => tool.name),
  },
  targets: [],
  tools: [...TOOLS, ...EXTENSION_TOOLS],
  skills: [],
  metrics,
};

const fleetMain = {
  agent_id: 'main',
  has_more: false,
  items: [{
    kind: 'turn', turnId: 't1', ordinal: 1, state: 'running', origin: { kind: 'user' },
    prompt: 'Cut the 0.4 release: split the audit across leads and report back.',
    startedAt: ts(42),
    steps: [{
      kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'running', startedAt: ts(42),
      frames: [{ kind: 'text', frameId: 'fleet-note', role: 'assistant', text: 'Eight leads are dispatched; two workers are waiting on your approval.' }],
    }],
  }],
  meta: {
    activity: 'turn',
    agent: {
      model: MODEL,
      thinkingEffort: 'high',
      permission: 'manual',
      contextTokens: 148_300,
      maxContextTokens: 262_144,
      phase: { kind: 'running', turnId: 1, step: 1, stepId: 't1.1', since: 0 },
    },
  },
};

const agentTranscripts = { main: fleetMain };
for (const row of rows) agentTranscripts[row.id] = childTranscript(row);

const usage = (overrides) => ({
  input_tokens: 81_000,
  output_tokens: 38_600,
  cache_read_tokens: 331_000,
  cache_creation_tokens: 0,
  total_cost_usd: 3.86,
  context_tokens: 148_300,
  context_limit: 262_144,
  turn_count: 14,
  ...overrides,
});

export default {
  agentPanel,
  sessions: [
    sessionRecord(FLEET, {
      title: 'Fixture: agent fleet',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'approval',
      created_at: ts(185),
      agent_config: { model: MODEL, permission_mode: 'manual' },
      usage: usage({}),
    }),
    sessionRecord(IDLE, {
      title: 'Fixture: idle overview',
      created_at: ts(26 * 60 + 12),
      updated_at: ts(9),
      agent_config: { model: MODEL, permission_mode: 'auto' },
      usage: usage({ turn_count: 23, context_tokens: 96_400 }),
    }),
  ],
  snapshots: {
    [FLEET]: {
      messages: [],
      has_more: false,
      subagents: roster,
      pending_approvals: pendingApprovals,
      agent_transcripts: agentTranscripts,
    },
    [IDLE]: {
      messages: [],
      has_more: false,
      agent_transcripts: {
        main: {
          agent_id: 'main',
          has_more: false,
          items: [{
            kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', origin: { kind: 'user' },
            prompt: 'Summarize what changed in the docs since yesterday.',
            startedAt: ts(12), endedAt: ts(9),
            steps: [{
              kind: 'step', stepId: 't1.1', turnId: 't1', ordinal: 1, state: 'completed', startedAt: ts(12), endedAt: ts(9),
              frames: [{ kind: 'text', frameId: 'idle-answer', role: 'assistant', text: 'Four pages changed: the install guide, two API references and the changelog.' }],
            }],
          }],
          meta: {
            activity: 'idle',
            agent: {
              model: MODEL,
              thinkingEffort: 'high',
              permission: 'auto',
              contextTokens: 96_400,
              maxContextTokens: 262_144,
              phase: { kind: 'ended', turnId: 1, reason: 'completed', at: 0 },
            },
          },
        },
      },
    },
  },
};

export const RAIL_SCALE = { FLEET, IDLE, AGENT_COUNT: rows.length, WAITING };
