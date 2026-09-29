/**
 * external-engines — external engines as Kiki executors, end to end:
 *
 * - Settings › Models & providers › Connections: an "External engines" list
 *   with Claude Code (signed out), Codex (ready, sign-in unknown until
 *   checked), Grok Build (ready) and a missing Gemini CLI. `executorChecks`
 *   seeds `POST /executors/{id}/check` answers.
 * - Agents: `reviewer-codex` runs on Codex with an `executor_prompt`
 *   (append + blocks, a Claude Code override) and the server's
 *   `executor_fields` applicability, including ignored fields it set.
 * - A session run by Codex: native tool cards (command, read, diff edit),
 *   a whole-turn diff, an engine compaction, steer delivery notes (delivered
 *   / queued / undelivered) and one unmapped update, all as quiet rows.
 *
 * Every executor shape mirrors packages/protocol/src/rest/executor.ts; the
 * values are mock data.
 */

import base from './profile-editor.scenario.mjs';
import { sessionRecord } from './helpers.mjs';

const SID = 'session_fixture_external_engines';
const WSID = 'wd_fixture_000000000000';
const HOME = 'C:/fixture/home/agents';
const t0 = Date.now() - 18 * 60_000;
const at = (seconds) => new Date(t0 + seconds * 1000).toISOString();

const REVIEWER_PROMPT = [
  'You are the reviewer. Read the candidate diff against the stated acceptance.',
  '',
  '- Report findings with file and line evidence.',
  '- Separate blocking defects from suggestions.',
  '- Do not rewrite the change yourself.',
].join('\n');

const IGNORED = (reason) => ({ state: 'ignored', reason });
const CODEX_FIELDS = {
  name: { state: 'applied' }, description: { state: 'applied' }, main: { state: 'applied' },
  prompt: { state: 'mapped', reason: 'Delivered as developer instructions' },
  pinned_model_alias: { state: 'mapped', reason: 'Uses the executor model identifier' },
  thinking_effort: { state: 'mapped', reason: 'Uses the executor thinking setting' },
  service_tier: IGNORED('Provider service tiers apply only to native execution'),
  request_params: IGNORED('Provider request parameters apply only to native execution'),
  tools: IGNORED('Tools are controlled by the external executor'),
  disallowed_tools: IGNORED('Tools are controlled by the external executor'),
  context_budget: IGNORED('Context budgets are controlled by the external executor'),
  auto_compact: IGNORED('Compaction is controlled by the external executor'),
  max_completion_tokens: IGNORED('Output limits are controlled by the external executor'),
  subagents: { state: 'applied' },
};

const executors = [
  { id: 'native', label: 'Kiki', protocol: 'native', status: 'ready', model_binding: 'mapped', thinking_binding: 'mapped' },
  {
    id: 'claude-acp', label: 'Claude Code', protocol: 'acp-v1', status: 'ready', version: '2.1.220',
    model_binding: 'mapped', thinking_binding: 'unavailable', default_profile: true,
    capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { via: 'session_mode', trust_engine_settings: true }, thinking_binding: false },
    connection: {
      command: 'C:/Users/fixture/AppData/Roaming/npm/claude-agent-acp.cmd', source: 'path',
      install_hint: 'npm i -g @agentclientprotocol/claude-agent-acp', login_command: ['claude'],
      login_status: 'logged_out', default_args: [],
    },
  },
  {
    id: 'codex-app-server', label: 'Codex', protocol: 'codex-app-server', status: 'ready', version: '0.158.0',
    model_binding: 'mapped', thinking_binding: 'mapped', default_profile: true,
    capabilities: { prompt_deliveries: ['append', 'replace', 'preamble'], steer: 'native', permission: { via: 'turn_param', trust_engine_settings: false }, model_binding: 'turn_param', thinking_binding: true },
    connection: {
      command: 'C:/Program Files/WindowsApps/OpenAI.Codex_1.4.2_x64/app/resources/codex.exe', source: 'desktop',
      install_hint: 'npm i -g @openai/codex@0.158.0', login_command: ['codex', 'login'],
      login_status: 'unknown', default_args: ['app-server', '--listen', 'stdio://'],
    },
  },
  {
    id: 'grok-acp', label: 'Grok Build', protocol: 'acp-v1', status: 'ready', version: '1.0.40',
    model_binding: 'mapped', thinking_binding: 'mapped', default_profile: true,
    capabilities: { prompt_deliveries: ['replace', 'preamble'], steer: 'next_turn_preamble', permission: { via: 'argv', trust_engine_settings: false }, model_binding: 'session_config', thinking_binding: true },
    connection: {
      command: 'C:/Users/fixture/.grok/bin/grok.exe', source: 'path', install_hint: 'Install the Grok Build CLI',
      login_command: ['grok'], login_status: 'logged_in', default_args: ['--no-auto-update', 'agent', 'stdio'],
    },
  },
  {
    id: 'gemini-acp', label: 'Gemini CLI', protocol: 'acp-v1', status: 'unavailable',
    model_binding: 'unavailable', thinking_binding: 'unavailable',
    capabilities: { prompt_deliveries: ['preamble'], steer: 'next_turn_preamble', permission: { trust_engine_settings: false }, thinking_binding: false },
    connection: { command: 'gemini', install_hint: 'npm i -g @google/gemini-cli', login_status: 'unknown', default_args: ['--experimental-acp'] },
  },
];
const executorChecks = {
  'claude-acp': {
    status: 'warning', version: '2.1.220', command: 'C:/Users/fixture/AppData/Roaming/npm/claude-agent-acp.cmd',
    selected_source: 'path', resolved_args: [], login_status: 'logged_out',
    diagnostics: [
      { severity: 'warning', message: 'claude auth status reports loggedIn: false. Run claude and sign in.' },
      { severity: 'info', message: 'Adapter 0.81.2 speaks ACP v1.' },
    ],
  },
  'codex-app-server': {
    status: 'ready', version: '0.158.0', command: 'C:/Program Files/WindowsApps/OpenAI.Codex_1.4.2_x64/app/resources/codex.exe',
    selected_source: 'desktop', resolved_args: ['app-server', '--listen', 'stdio://'], login_status: 'unknown',
    diagnostics: [
      { severity: 'info', message: 'Codex auth state exists at C:/Users/fixture/.codex/auth.json.' },
      { severity: 'info', message: 'Codex uses app-server --listen stdio:// with on-request approvals and no bypass flag.' },
    ],
  },
  'gemini-acp': {
    status: 'unavailable', command: 'gemini', resolved_args: ['--experimental-acp'], login_status: 'unknown',
    diagnostics: [{ severity: 'error', message: 'gemini was not found on PATH.' }],
  },
};

const reviewerCodex = {
  name: 'reviewer-codex', source: 'user', workspace_id: WSID, source_file: `${HOME}/reviewer-codex.md`, main: false, disabled: false,
  subagent_policy: 'advisory', routes: [], subagents: [],
  description: 'Independent review on Codex.', when_to_use: 'A candidate diff needs a second engine’s read.',
  prompt: REVIEWER_PROMPT, executor: 'codex-app-server', executor_protocol: 'codex-app-server',
  pinned_model_alias: 'gpt-5.5-codex', thinking_effort: 'high', service_tier: 'priority', tools: ['Read', 'Grep'],
  executor_prompt: {
    delivery: 'append',
    include: ['agents_md', 'workspace_info', 'system.review-rubric'],
    append: 'Answer in the review format: Blocking, Suggestions, Checked.',
    per_engine: {
      'claude-acp': { delivery: 'replace', include: ['agents_md', 'memory_snapshot'], body: 'You review diffs for this workspace. Cite file and line.' },
    },
  },
  executor_fields: CODEX_FIELDS,
};

const turn = (n, prompt, frames, startAt, endAt) => ({
  kind: 'turn', turnId: `t${n}`, ordinal: n, state: 'completed',
  origin: { kind: 'user', payload: { promptId: `p-eng-${n}`, userMessageId: `um-eng-${n}` } },
  prompt, startedAt: at(startAt), endedAt: at(endAt), durationMs: (endAt - startAt) * 1000,
  execution: {
    executorId: 'codex-app-server', protocol: 'codex-app-server', resumeMode: n === 1 ? 'new' : 'live',
    // The engine also emits developer_instructions / base_instructions, which
    // the transcript contract schema does not accept yet; stay inside it.
    profileDelivery: n === 1 ? 'native' : 'first_prompt_preamble', fidelity: n === 1 ? 'full' : 'degraded',
    losses: n === 1 ? [] : ['codex_no_step_boundaries', 'prompt_delivery_downgraded', 'permission_mode_unverified'],
  },
  steps: [{ kind: 'step', stepId: `t${n}.1`, turnId: `t${n}`, ordinal: 1, state: 'completed', frames }],
});

const BEFORE = ['export function parseLimit(raw: string): number {', '  return Number(raw);', '}', ''].join('\n');
const AFTER = ['export function parseLimit(raw: string): number {', '  const value = Number.parseInt(raw, 10);', '  if (!Number.isFinite(value) || value < 1) throw new RangeError(`limit must be positive: ${raw}`);', '  return value;', '}', ''].join('\n');
const TURN_DIFF = [
  'diff --git a/src/limits.ts b/src/limits.ts',
  '--- a/src/limits.ts',
  '+++ b/src/limits.ts',
  '@@ -1,3 +1,5 @@',
  ' export function parseLimit(raw: string): number {',
  '-  return Number(raw);',
  '+  const value = Number.parseInt(raw, 10);',
  '+  if (!Number.isFinite(value) || value < 1) throw new RangeError(`limit must be positive: ${raw}`);',
  '+  return value;',
  ' }',
  'diff --git a/src/limits.test.ts b/src/limits.test.ts',
  '--- a/src/limits.test.ts',
  '+++ b/src/limits.test.ts',
  '@@ -4,2 +4,5 @@',
  " it('parses a limit', () => {",
  "   expect(parseLimit('20')).toBe(20);",
  '+});',
  "+it('rejects zero', () => {",
  "+  expect(() => parseLimit('0')).toThrow(RangeError);",
].join('\n');

const marker = (id, name, payload, seconds) => ({ kind: 'marker', markerId: id, marker: name, payload, at: at(seconds) });
const items = [
  turn(1, 'Why does /api/items?limit=0 return everything?', [
    { kind: 'text', frameId: 'eng-t1-a', role: 'assistant', text: 'I’ll look at how the limit is parsed.' },
    { kind: 'tool', frameId: 'eng-t1-rg', toolCallId: 'external:codex:call_rg', name: 'rg parseLimit', state: 'done',
      input: { command: 'rg -n parseLimit src' }, display: { kind: 'command', command: 'rg -n parseLimit src' },
      output: 'src/limits.ts:1:export function parseLimit(raw: string): number {\nsrc/routes/items.ts:14:  const limit = parseLimit(query.limit);' },
    { kind: 'tool', frameId: 'eng-t1-read', toolCallId: 'external:codex:call_read', name: 'Read src/limits.ts', state: 'done',
      input: { path: 'src/limits.ts' }, display: { kind: 'file_io', operation: 'read', path: 'src/limits.ts' }, output: BEFORE },
    { kind: 'text', frameId: 'eng-t1-b', role: 'assistant', text: '`Number("0")` is 0, and the route treats a falsy limit as “no limit”. `parseLimit` should reject anything below 1.' },
  ], 0, 42),
  turn(2, 'Fix it and add a test.', [
    { kind: 'tool', frameId: 'eng-t2-edit', toolCallId: 'external:codex:call_edit', name: 'Edit src/limits.ts', state: 'done',
      input: { path: 'src/limits.ts' }, display: { kind: 'diff', path: 'src/limits.ts', before: BEFORE, after: AFTER }, output: 'Applied patch to src/limits.ts' },
    { kind: 'tool', frameId: 'eng-t2-test', toolCallId: 'external:codex:call_test', name: 'pnpm vitest run src/limits.test.ts', state: 'done',
      input: { command: 'pnpm vitest run src/limits.test.ts' }, display: { kind: 'command', command: 'pnpm vitest run src/limits.test.ts' },
      output: ' ✓ src/limits.test.ts (2 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)' },
    { kind: 'text', frameId: 'eng-t2-b', role: 'assistant', text: '`parseLimit` now throws a `RangeError` below 1, and the route returns 400 for it. Both tests pass.' },
  ], 48, 131),
  marker('eng-hint-1', 'executor.prompt.delivery', { turnId: 2, promptId: 'p-eng-steer', origin: 'user', method: 'native_steer', status: 'delivered' }, 96),
  marker('eng-diff-2', 'executor.diff', { turnId: 2, kind: 'diff', value: TURN_DIFF }, 131),
  marker('eng-compact-2', 'executor.compaction', { turnId: 2, kind: 'compaction', value: { threadId: 'thr_fixture' } }, 133),
  marker('eng-unknown-2', 'executor.degradation', { turnId: 2, kind: 'unknown', value: { updateType: 'thread/rateLimits/updated' } }, 134),
  marker('eng-hint-2', 'executor.prompt.delivery', { promptId: 'p-eng-queued', origin: 'user', method: 'next_turn_preamble', status: 'queued' }, 136),
  marker('eng-hint-3', 'executor.prompt.delivery', { promptId: 'p-eng-dropped', origin: 'user', method: 'undelivered', status: 'undelivered' }, 138),
];

export default {
  ...base,
  executors,
  executorChecks,
  agentProfiles: [...base.agentProfiles, reviewerCodex],
  sessions: [sessionRecord(SID, { title: 'Fixture: Codex engine' })],
  snapshots: {
    [SID]: {
      messages: [],
      has_more: false,
      agent_transcripts: { main: { agent_id: 'main', has_more: false, items } },
    },
  },
};
