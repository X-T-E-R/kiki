/**
 * external-main — an external harness bound as the MAIN profile, next to the
 * native surfaces it should read like:
 *
 * - `lead-claude` (Claude Code main, `allow_kiki_subagents: true`,
 *   `kiki_context: [memory, history, hooks]`), `lead-codex` (Codex main,
 *   `kiki_context: []`), `lead-antigravity` (hooks untested), `lead-grok`.
 * - Kiki hook injections (`hook_result`, `kiki:claude:*`) in the Claude
 *   session: SessionStart, UserPromptSubmit and a prepare-only PreCompact.
 * - Session "Claude main": a finished turn with native-shaped tool cards, a
 *   Kiki dispatch through the injected MCP bridge, the engine's plan as the
 *   Todo list, usage, the engine reporting a dropped pasted image and its own
 *   context reading (twice — only the newest belongs in the turn) plus the
 *   identity it is actually running, then a failed turn (sign-in lapsed) to
 *   recover from.
 * - Session "Grok main": a pending `plan_review` interaction from
 *   `_x.ai/exit_plan_mode`.
 * - Session "Codex main" in YOLO: the MCP-approval limitation applies.
 * - Settings › Connections: Antigravity ACP (binary cache + Google sign-in,
 *   scripts/fixture-antigravity.mjs) with the IDE-not-CLI diagnostic.
 *
 * `capabilities.negotiated` mirrors packages/protocol/src/rest/executor.ts;
 * every value is mock data.
 */

import base from './profile-editor.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

const WSID = 'wd_fixture_000000000000';
const HOME = 'C:/fixture/home/agents';
const t0 = Date.now() - 26 * 60_000;
const at = (seconds) => new Date(t0 + seconds * 1000).toISOString();
const expires = new Date(Date.now() + 23 * 3600_000).toISOString();

const CLAUDE = 'session_fixture_external_claude';
const GROK = 'session_fixture_external_grok';
const CODEX = 'session_fixture_external_codex';

const LEAD_PROMPT = [
  'You lead this workspace from Claude Code. Frame the problem, delegate bounded work, accept the result.',
  '',
  '- Use the Kiki tools to dispatch Kiki subagents; results come back to this session.',
  '- Keep simple serial work inline.',
].join('\n');

const profile = (name, fields) => ({
  name, source: 'user', workspace_id: WSID, source_file: `${HOME}/${name}.md`, main: true, disabled: false,
  subagent_policy: 'advisory', routes: [], prompt: LEAD_PROMPT, ...fields,
});

const MAIN_FIELDS = (engine) => ({
  name: { state: 'applied' }, description: { state: 'applied' }, main: { state: 'applied' },
  prompt: { state: 'mapped', reason: `Sent to ${engine} with the first message.` },
  pinned_model_alias: { state: 'mapped' },
  tools: { state: 'ignored', reason: `${engine} decides its own tool set; tool lists are kept but not sent.` },
  disallowed_tools: { state: 'ignored', reason: `${engine} decides its own tool set; tool lists are kept but not sent.` },
  subagents: { state: 'applied' },
});

const agentProfiles = [
  ...base.agentProfiles,
  profile('lead-claude', {
    description: 'Workspace lead on Claude Code.', executor: 'claude-acp', executor_protocol: 'acp-v1',
    pinned_model_alias: 'claude-sonnet-4.5', allow_kiki_subagents: true, kiki_context: ['memory', 'history', 'hooks'],
    subagents: ['explore', 'implementer', 'reviewer'], executor_fields: MAIN_FIELDS('Claude Code'),
  }),
  profile('lead-codex', {
    description: 'Workspace lead on Codex.', executor: 'codex-app-server', executor_protocol: 'codex-app-server',
    pinned_model_alias: 'gpt-5.5-codex', thinking_effort: 'high', allow_kiki_subagents: true, kiki_context: [], subagents: ['explore'], executor_fields: MAIN_FIELDS('Codex'),
  }),
  profile('lead-antigravity', {
    description: 'Workspace lead on Antigravity.', executor: 'antigravity-acp', executor_protocol: 'acp-v1',
    subagents: [], executor_fields: MAIN_FIELDS('Antigravity'),
  }),
  profile('lead-grok', {
    description: 'Workspace lead on Grok Build.', executor: 'grok-acp', executor_protocol: 'acp-v1',
    pinned_model_alias: 'grok-4.7', subagents: [], executor_fields: MAIN_FIELDS('Grok Build'),
  }),
];

const executors = [
  { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
  {
    id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', version: '0.84.0',
    model_binding: 'mapped', thinking_binding: 'unavailable', default_profile: true,
    capabilities: {
      prompt_deliveries: ['preamble'], steer: 'native', permission: { via: 'session_mode', trust_engine_settings: true }, thinking_binding: false,
      negotiated: { agent_version: '0.84.0', image: true, audio: false, fork: true, native_steering: true, question_form: false, plan_approval: false, resume: true, load: true },
    },
    connection: { command: 'C:/Users/fixture/.kiki/tools/claude-agent-acp/dist/index.js', source: 'kiki-managed', login_status: 'logged_in', default_args: [] },
  },
  {
    id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.155.0',
    model_binding: 'mapped', thinking_binding: 'mapped', default_profile: true,
    capabilities: {
      prompt_deliveries: ['append', 'replace', 'preamble'], steer: 'native', permission: { via: 'turn_param', trust_engine_settings: false }, model_binding: 'turn_param', thinking_binding: true,
      negotiated: { agent_version: '0.155.0-alpha.16.3', image: true, audio: false, fork: false, native_steering: true, question_form: true, plan_approval: false },
    },
    connection: { command: 'C:/Users/fixture/AppData/Roaming/npm/codex.cmd', source: 'path', login_command: ['codex', 'login'], login_status: 'logged_in', default_args: ['app-server', '--listen', 'stdio://'] },
  },
  {
    id: 'grok-acp', label: 'Grok Build', protocol: 'acp-v1', status: 'ready', version: '1.0.40',
    model_binding: 'mapped', thinking_binding: 'mapped', default_profile: true,
    capabilities: {
      prompt_deliveries: ['replace', 'preamble'], steer: 'next_turn_preamble', permission: { via: 'argv', trust_engine_settings: false }, model_binding: 'session_config', thinking_binding: true,
      negotiated: { agent_version: '1.0.40', image: true, audio: false, fork: false, native_steering: false, question_form: false, plan_approval: true },
    },
    connection: { command: 'C:/Users/fixture/.grok/bin/grok.exe', source: 'path', login_command: ['grok'], login_status: 'logged_in', default_args: ['--no-auto-update', 'agent', 'stdio'] },
  },
  {
    id: 'antigravity-acp', label: 'Antigravity', protocol: 'acp-v1', status: 'unavailable',
    model_binding: 'mapped', thinking_binding: 'unavailable',
    capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { via: 'session_mode', trust_engine_settings: false }, thinking_binding: false },
    connection: {
      command: 'agy_acp_server', login_status: 'unknown', default_args: [], home_env: 'GEMINI_HOME',
      install_hint: 'Install Google Antigravity ACP CLI through the Antigravity executor binary cache (default 1.2.1); the Antigravity IDE is not an ACP CLI.',
    },
  },
];

const IDE_DIAGNOSTIC = '这是 Antigravity IDE，不是 ACP CLI。请通过 Antigravity 执行器的二进制缓存安装 Google Antigravity ACP CLI 1.x（默认 1.2.1），或设置 ANTIGRAVITY_ACP_PATH 指向 agy_acp_server（保留同目录 localharness_external）。';

const executorChecks = {
  'antigravity-acp': {
    status: 'unavailable', command: '', resolved_args: [], login_status: 'unknown',
    diagnostics: [{ code: 'antigravity_ide_not_acp', severity: 'error', message: IDE_DIAGNOSTIC }],
    requirements: [{ id: 'antigravity-acp', label: 'Antigravity ACP CLI', role: 'program', status: 'missing',
      install_hint: 'Install Google Antigravity ACP CLI through the Antigravity executor binary cache (default 1.2.1); the Antigravity IDE is not an ACP CLI.' }],
  },
};

const execution = (executorId, protocol, extra = {}) => ({
  executorId, protocol, resumeMode: 'live', profileDelivery: 'first_prompt_preamble', fidelity: 'full', losses: [], ...extra,
});
const usage = (input, output, cache) => ({ inputOther: input, output, inputCacheRead: cache, inputCacheCreation: 0 });
const turn = (n, prompt, frames, { state = 'completed', startAt, endAt, exec, error, stepUsage } = {}) => ({
  kind: 'turn', turnId: `t${n}`, ordinal: n, state,
  origin: { kind: 'user', payload: { promptId: `p-ext-${n}`, userMessageId: `um-ext-${n}` } },
  prompt, startedAt: at(startAt), ...(endAt === undefined ? {} : { endedAt: at(endAt), durationMs: (endAt - startAt) * 1000 }),
  execution: exec, ...(error === undefined ? {} : { error }),
  steps: [{ kind: 'step', stepId: `t${n}.1`, turnId: `t${n}`, ordinal: 1, state: state === 'running' ? 'running' : state === 'failed' ? 'failed' : 'completed', frames, usage: stepUsage }],
});

const CLAUDE_EXEC = execution('claude-acp', 'acp-v1');
/** A durable engine marker as the wire records it: `payload` is the record. */
const marker = (id, markerName, payload, seconds) => ({ kind: 'marker', markerId: id, marker: markerName, payload, at: at(seconds) });
const PLAN = [
  { title: 'Read the limit parser and its callers', status: 'done' },
  { title: 'Dispatch a Kiki reviewer on the fix', status: 'in_progress' },
  { title: 'Summarize the change for the user', status: 'pending' },
];
const hookFrame = (frameId, event, text) => ({
  kind: 'text', frameId, role: 'user', text, origin: { kind: 'hook_result', event, blocked: false },
});
const HOOK_START = [
  '[Kiki memory]', '- Prefers pnpm over npm in this repo.', '- API errors use RFC 9457 problem details.',
  '', '[Kiki goal_state]', 'Goal (active): limit=0 answers 400 on /api/items',
].join('\n');
const HOOK_PROMPT = ['[Kiki todo_state]', 'Working notes:', 'next: cover negative values', '', '- [x] Fix parseLimit', '- [ ] Add tests for -1 and abc'].join('\n');
const HOOK_COMPACT = ['[Handoff prepared; not injected by this hook]', '[Kiki handoff]',
  'Preserve the current goal, working notes, constraints, decisions, and next action in the compaction handoff.'].join('\n');
const claudeItems = [
  turn(1, 'Fix /api/items?limit=0 (I pasted a screenshot of the response) and get an independent review.', [
    hookFrame('cl-t1-hook-start', 'kiki:claude:SessionStart', HOOK_START),
    { kind: 'thinking', frameId: 'cl-t1-think', text: 'The limit parser treats 0 as falsy. I will read it, fix it, then ask a Kiki reviewer for a second read.' },
    { kind: 'tool', frameId: 'cl-t1-read', toolCallId: 'external:claude:read', name: 'Read src/limits.ts', state: 'done',
      input: { path: 'src/limits.ts' }, display: { kind: 'file_io', operation: 'read', path: 'src/limits.ts' },
      output: 'export function parseLimit(raw: string): number {\n  return Number(raw);\n}\n' },
    { kind: 'tool', frameId: 'cl-t1-test', toolCallId: 'external:claude:test', name: 'pnpm vitest run src/limits.test.ts', state: 'done',
      input: { command: 'pnpm vitest run src/limits.test.ts' }, display: { kind: 'command', command: 'pnpm vitest run src/limits.test.ts' },
      output: ' ✓ src/limits.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)' },
    { kind: 'tool', frameId: 'cl-t1-dispatch', toolCallId: 'external:claude:dispatch', name: 'mcp__kiki-harness__kiki_dispatch', state: 'done',
      input: { target: 'named', profileName: 'reviewer', taskName: 'review-limit-fix', message: 'Review the parseLimit fix in src/limits.ts against: limit=0 must return 400.' },
      output: '{"dispatchId":"dsp_fixture_01","status":"running","agentId":"agent-review-limit-fix"}' },
    { kind: 'text', frameId: 'cl-t1-a', role: 'assistant', text: '`parseLimit` now rejects anything below 1 and the route answers 400. I dispatched a Kiki reviewer; its report comes back to this session when it finishes.' },
  ], { startAt: 0, endAt: 74, exec: CLAUDE_EXEC, stepUsage: usage(18_400, 2_300, 41_000) }),
  // The engine's own report of what it is running (`session.info` → runtime
  // kind `session`): an observation, never a Kiki model choice.
  marker('cl-t1-model', 'executor.session', {
    turnId: 1, executorId: 'claude-acp', kind: 'session',
    value: { meta: { source: 'claude-acp', actualModel: 'claude-sonnet-4.5', agentVersion: '0.84.0' } },
  }, 2),
  // The engine reported the pasted screenshot as dropped, then read its own
  // context twice; only the newest reading belongs in the turn.
  marker('cl-t1-image-dropped', 'executor.session', {
    turnId: 1, executorId: 'claude-acp', kind: 'session',
    value: { meta: { imageDropped: { reason: 'the image is larger than Claude Code accepts', notes: ['Pasted screenshot.png · 6.2 MB'] } } },
  }, 6),
  marker('cl-t1-usage-early', 'executor.usage', {
    turnId: 1, executorId: 'claude-acp', kind: 'usage',
    value: { type: 'usage', used: 18_400, size: 200_000 },
  }, 20),
  marker('cl-t1-usage-late', 'executor.usage', {
    turnId: 1, executorId: 'claude-acp', kind: 'usage',
    value: { type: 'usage', used: 61_700, size: 200_000 },
  }, 60),
  turn(2, 'Also cover negative values.', [
    hookFrame('cl-t2-hook-prompt', 'kiki:claude:UserPromptSubmit', HOOK_PROMPT),
    hookFrame('cl-t2-hook-compact', 'kiki:claude:PreCompact', HOOK_COMPACT),
    { kind: 'notice', frameId: 'cl-t2-err', level: 'error', source: 'executor', message: 'Claude Code: Authentication required. Sign in with `claude auth login`, then send again.' },
  ], { state: 'failed', startAt: 90, endAt: 92, exec: CLAUDE_EXEC, error: 'Authentication required' }),
];

const GROK_EXEC = execution('grok-acp', 'acp-v1', { profileDelivery: 'system_prompt_override' });
const GROK_PLAN = [
  '## Plan: harden limit parsing',
  '',
  '1. Reject limit values below 1 in `parseLimit` with a `RangeError`.',
  '2. Map the error to HTTP 400 in `src/routes/items.ts`.',
  '3. Add tests for `0`, `-1` and `abc`.',
].join('\n');
const grokItems = [
  turn(1, 'Plan the limit fix before touching code.', [
    { kind: 'tool', frameId: 'gk-t1-rg', toolCallId: 'external:grok:rg', name: 'grep parseLimit', state: 'done',
      input: { command: 'rg -n parseLimit src' }, display: { kind: 'command', command: 'rg -n parseLimit src' },
      output: 'src/limits.ts:1:export function parseLimit(raw: string): number {\nsrc/routes/items.ts:14:  const limit = parseLimit(query.limit);' },
    { kind: 'tool', frameId: 'gk-t1-plan', toolCallId: 'external:grok:plan', name: 'exit_plan_mode', state: 'running',
      input: { plan: GROK_PLAN }, display: { kind: 'plan_review', plan: GROK_PLAN } },
  ], { state: 'running', startAt: 0, exec: GROK_EXEC }),
];
const grokInteractions = [
  {
    interactionId: 'grok-plan:fixture', interactionKind: 'approval', toolCallId: 'external:grok:plan', state: 'pending',
    request: { turnId: 1, toolCallId: 'external:grok:plan', toolName: 'Exit plan mode', action: 'Review external plan',
      display: { kind: 'plan_review', plan: GROK_PLAN }, created_at: at(40), expires_at: expires },
  },
];

const CODEX_EXEC = execution('codex-app-server', 'codex-app-server', { profileDelivery: 'developer_instructions' });
const codexItems = [
  turn(1, 'List the Kiki profiles you can dispatch, then open the issue tracker.', [
    { kind: 'tool', frameId: 'cx-t1-profiles', toolCallId: 'external:codex:profiles', name: 'kiki-harness/kiki_profiles', state: 'done',
      input: {}, output: '{"profiles":[{"name":"reviewer"},{"name":"coder"}]}' },
    { kind: 'tool', frameId: 'cx-t1-tracker', toolCallId: 'external:codex:tracker', name: 'tracker/list_issues', state: 'error',
      input: { project: 'example' }, output: 'MCP tool call requires approval, but approval policy is never',
      error: 'MCP tool call requires approval, but approval policy is never', errorCode: 'codex_mcp_approval_denied' },
    { kind: 'text', frameId: 'cx-t1-a', role: 'assistant', text: 'Kiki lists two dispatchable profiles: reviewer and coder. The tracker server needs approval, which this mode does not ask for.' },
  ], { startAt: 0, endAt: 12, exec: CODEX_EXEC, stepUsage: usage(6_100, 380, 12_000) }),
  marker('cx-t1-model', 'executor.session', {
    turnId: 1, executorId: 'codex-app-server', kind: 'session',
    value: { meta: { source: 'codex-app-server', actualModel: 'gpt-5.5-codex', modelProvider: 'openai' } },
  }, 1),
  // Codex reports its own context (thread/tokenUsage/updated) the same way.
  marker('cx-t1-usage', 'executor.usage', {
    turnId: 1, executorId: 'codex-app-server', kind: 'usage',
    value: { type: 'usage', used: 6_100, size: 272_000 },
  }, 11),
];

const snapshot = (items, extra = {}) => ({
  messages: [], has_more: false,
  agent_transcripts: { main: { agent_id: 'main', has_more: false, items, ...extra } },
});

export default {
  ...base,
  executors,
  executorChecks,
  agentProfiles,
  antigravity: { versions: [], signed_in: false, install_delay_ms: 700, expires_in_secs: 300 },
  sessions: [
    sessionRecord(CLAUDE, { title: 'Fixture: Claude main', agent_config: { model: 'claude-sonnet-4.5', profile: 'lead-claude', permission_mode: 'manual' },
      usage: { input_tokens: 18_400, output_tokens: 2_300, cache_read_tokens: 41_000, cache_creation_tokens: 0, total_cost_usd: 0.1184, context_tokens: 61_700, context_limit: 200_000, turn_count: 2 } }),
    sessionRecord(GROK, { title: 'Fixture: Grok main', busy: true, main_turn_active: true, pending_interaction: 'approval',
      agent_config: { model: 'grok-4.7', profile: 'lead-grok', permission_mode: 'manual' } }),
    sessionRecord(CODEX, { title: 'Fixture: Codex main', agent_config: { model: 'gpt-5.5-codex', profile: 'lead-codex', permission_mode: 'yolo' } }),
  ],
  snapshots: {
    [CLAUDE]: snapshot(claudeItems, { todos: [{ todoId: 'external-plan', items: PLAN, updatedAt: at(60) }] }),
    [GROK]: {
      ...snapshot(grokItems, { interactions: grokInteractions }),
      pending_approvals: [{
        approval_id: 'grok-plan:fixture', session_id: GROK, turn_id: 1, tool_call_id: 'external:grok:plan', tool_name: 'Exit plan mode',
        action: 'Review external plan', tool_input_display: { kind: 'plan_review', plan: GROK_PLAN }, created_at: at(40), expires_at: expires,
      }],
    },
    [CODEX]: snapshot(codexItems, { meta: { agent: { permission: 'yolo' } } }),
  },
};
