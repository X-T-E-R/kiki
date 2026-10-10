import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigChanged, IConfigService, IEventService } from '@kiki/agent-core-v2';
import { HooksConfigSchema } from '@kiki/agent-core-v2/features/externalHooks/configSection';
import { ExternalHooksRunnerService } from '@kiki/agent-core-v2/features/externalHooks/app/externalHooksRunnerService';
import { configResponseSchema as sharedConfigResponseSchema, patchConfigRequestSchema as sharedPatchConfigRequestSchema, hooksConfigSchema } from '@kiki/protocol';
import { IRequestGovernance } from '@kiki/agent-core-v2/app/requestGovernance/requestGovernance';
import type { RequestAttempt } from '@kiki/agent-core-v2/kosong/model/requestAdmission';
import { configResponseSchema, patchConfigRequestSchema, type ConfigResponse } from '../src/protocol/rest-config';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authedFetch } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('hooks config schema parity', () => {
  it('keeps engine, server and browser schemas on the same config contract', () => {
    const rule = { id: 'example', event: 'step.before', action: { type: 'inject', text: 'Example guidance' } };
    const legacy = { event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 };
    const valid = [
      [], [legacy], [{ ...legacy, command: ' ', timeout: 1 }],
      { schemaVersion: 2 },
      { schemaVersion: 2, enabled: false, disabled: [''], files: [' '], rules: [rule], legacy: [legacy] },
      { schemaVersion: 2, rules: [{ ...rule, action: { type: 'inject', textFile: 'guidance/example.txt' }, cadence: { everyCompletedSteps: 3 } }] },
      { schemaVersion: 2, rules: [{ ...rule, event: 'prompt.submit' }] },
      ...['prompt.submit', 'step.before', 'step.after', 'turn.after', 'session.start', 'turn.stopping', 'tool.before', 'tool.after'].map((event) => ({ schemaVersion: 2, rules: [{ ...rule, event, action: { type: 'observe' } }] })),
    ];
    const invalidRules = [
      { ...rule, id: '-invalid' }, { ...rule, event: 'unknown' }, { ...rule, priority: 1.5 }, { ...rule, enabled: 1 },
      { ...rule, extra: true }, { ...rule, match: { unknown: [] } }, { ...rule, match: { models: [] } },
      { ...rule, match: { profiles: [''] } }, { ...rule, match: { agentRoles: ['child'] } },
      { ...rule, match: { statuses: ['unknown'] } }, { ...rule, match: { sources: ['unknown'] } }, { ...rule, match: { outcomes: ['unknown'] } },
      { ...rule, cadence: { everyCompletedSteps: 0 } }, { ...rule, cadence: { everyCompletedSteps: 1.5 } },
      { ...rule, cadence: { everyCompletedSteps: 1, counterScope: 'session' } }, { ...rule, cadence: { everyCompletedSteps: 1, partitionBy: 'profile' } },
      { ...rule, event: 'prompt.submit', cadence: { everyCompletedSteps: 1 } },
      ...['step.after', 'turn.after', 'session.start', 'turn.stopping', 'tool.before', 'tool.after'].map((event) => ({ ...rule, event })),
      ...['command', 'gate', 'block', 'continue'].map((type) => ({ ...rule, action: { type } })),
      { ...rule, action: { type: 'inject' } }, { ...rule, action: { type: 'inject', text: ' ' } },
      { ...rule, action: { type: 'inject', text: 'example', textFile: 'example.txt' } }, { ...rule, action: { type: 'inject', textFile: '' } },
      { ...rule, action: { type: 'observe', text: 'example' } },
    ];
    const invalid = [
      null, true, '[]', 2, {}, { schemaVersion: 1 }, { schema_version: 2 },
      { schemaVersion: 2, enabled: 1 }, { schemaVersion: 2, disabled: [1] }, { schemaVersion: 2, files: [''] },
      { schemaVersion: 2, rules: {} }, { schemaVersion: 2, legacy: {} }, { schemaVersion: 2, unknown: true },
      ...[{}, { ...legacy, event: 'unknown' }, { ...legacy, command: '' }, { ...legacy, matcher: '[' }, { ...legacy, timeout: 0 }, { ...legacy, timeout: 601 }, { ...legacy, timeout: 1.5 }, { ...legacy, cwd: 'example' }, { ...legacy, env: {} }].flatMap((hook) => [[hook], { schemaVersion: 2, legacy: [hook] }]),
      ...invalidRules.map((invalidRule) => ({ schemaVersion: 2, rules: [invalidRule] })),
    ];
    for (const [values, expected] of [[valid, true], [invalid, false]] as const) {
      for (const value of values) {
        const engine = HooksConfigSchema.safeParse(value);
        expect(engine.success, JSON.stringify(value)).toBe(expected);
        const shared = hooksConfigSchema.safeParse(value);
        expect(shared.success, JSON.stringify(value)).toBe(expected);
        if (engine.success && shared.success) expect(shared.data).toEqual(engine.data);
        for (const schema of [configResponseSchema, patchConfigRequestSchema, sharedConfigResponseSchema, sharedPatchConfigRequestSchema]) {
          const result = schema.safeParse({ hooks: value });
          expect(result.success, JSON.stringify(value)).toBe(expected);
          if (result.success && engine.success) expect(result.data.hooks).toEqual(engine.data);
        }
      }
    }
  });
});

describe('server-v2 /api/config', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-config-'));
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('NB_SEARCH_')) vi.stubEnv(key, undefined);
    }
    vi.stubEnv('NB_SEARCH_HOME', join(home, 'local-nb-search'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      home = undefined;
    }
  });

  async function boot(toml?: string, selectedHome = home as string): Promise<void> {
    if (toml !== undefined) {
      await writeFile(join(selectedHome, 'config.toml'), toml, 'utf-8');
    }
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: selectedHome,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function getConfig(): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function patchConfig(patch: Record<string, unknown>): Promise<ConfigResponse> {
    const res = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<ConfigResponse>;
    expect(body.code).toBe(0);
    return configResponseSchema.parse(body.data);
  }

  async function readCredentialsFile(): Promise<string> {
    return readFile(join(home as string, 'credentials', 'credentials.toml'), 'utf-8').catch(() => '');
  }

  it('round trips computer preference and removes the override without changing permissions or installing MCP', async () => {
    await boot('default_permission_mode="manual"\n[search]\nenabled=false\n');
    expect((await getConfig()).computer_control).toEqual({ usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request' });
    const patch = { computer_control: { usage_preference: 'prefer' } };
    expect(sharedPatchConfigRequestSchema.parse(patch).computer_control).toEqual(patch.computer_control);
    const edited = await patchConfig(patch);
    expect(edited.computer_control).toEqual({ usagePreference: 'prefer', usagePreferenceSource: 'home', appliesOn: 'next-model-request' });
    expect(sharedConfigResponseSchema.parse(edited).computer_control).toEqual(edited.computer_control);
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).toContain('usage_preference = "prefer"');
    await server!.close(); server = undefined; await boot();
    expect((await getConfig()).computer_control).toEqual(edited.computer_control);
    const reset = await patchConfig({ computer_control: { usage_preference: null } });
    expect(reset.computer_control).toEqual({ usagePreference: 'avoid', usagePreferenceSource: 'default', appliesOn: 'next-model-request' });
    expect(reset.permission).toEqual(edited.permission);
    expect(reset.default_permission_mode).toBe(edited.default_permission_mode);
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).not.toContain('usage_preference');
    expect(await readFile(join(home as string, 'mcp.json'), 'utf-8').catch(() => undefined)).toBeUndefined();
    expect(sharedPatchConfigRequestSchema.safeParse({ computer_control: { usage_preference: false } }).success).toBe(false);
  });

  it('round trips question frequency guard through global REST and cold config reload', async () => {
    await boot('[search]\nenabled=false\n[interaction]\nask_user_question="blocking"\n');
    expect((await getConfig()).interaction).toEqual({ askUserQuestion: 'blocking' });
    const patch = { interaction: { ask_user_question_guard: { enabled: true, max_per_user_round: 2, max_per_window: 4, window_ms: 120000 } } };
    expect(sharedPatchConfigRequestSchema.parse(patch).interaction).toEqual(patch.interaction);
    const edited = await patchConfig(patch);
    expect(edited.interaction).toEqual({ askUserQuestion: 'blocking', askUserQuestionGuard: { enabled: true, maxPerUserRound: 2, maxPerWindow: 4, windowMs: 120000 } });
    expect(sharedConfigResponseSchema.parse(edited).interaction).toEqual(edited.interaction);
    const text = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(text).toContain('ask_user_question_guard'); expect(text).toContain('max_per_user_round = 2'); expect(text).not.toContain('maxPerUserRound');
    await server!.close(); server = undefined; await boot();
    expect((await getConfig()).interaction).toEqual(edited.interaction);
    const disabled = await patchConfig({ interaction: { ask_user_question_guard: { enabled: false } } });
    expect(disabled.interaction?.askUserQuestionGuard).toEqual({ enabled: false, maxPerUserRound: 2, maxPerWindow: 4, windowMs: 120000 });
  });

  it('round trips file-configured v2 hooks through REST without executing legacy commands', async () => {
    const marker = join(home as string, 'hook-executed');
    const command = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)}`;
    const trigger = vi.spyOn(ExternalHooksRunnerService.prototype, 'trigger');
    await boot(`[hooks]
schema_version = 2
enabled = false
disabled = ["project.reminder"]
files = ["hooks/example.toml"]
[[hooks.rules]]
id = "reminder"
event = "step.before"
priority = -10
enabled = true
[hooks.rules.match]
models = ["example/model"]
profiles = ["example"]
routes = ["native"]
executors = ["native"]
agent_roles = ["root"]
tools = ["Read"]
statuses = ["success"]
sources = ["user"]
outcomes = ["completed"]
[hooks.rules.cadence]
every_completed_steps = 3
counter_scope = "turn"
partition_by = "model"
[hooks.rules.action]
type = "inject"
text_file = "guidance/example.txt"
[[hooks.rules]]
id = "audit"
event = "turn.after"
priority = 200
enabled = false
[hooks.rules.match]
[hooks.rules.action]
type = "observe"
[[hooks.rules]]
id = "greeting"
event = "prompt.submit"
[hooks.rules.action]
type = "inject"
text = "Example guidance"
[[hooks.legacy]]
event = "SessionStart"
command = ${JSON.stringify(command)}
matcher = "^Read$"
timeout = 600
`);
    const expected = {
      schemaVersion: 2, enabled: false, disabled: ['project.reminder'], files: ['hooks/example.toml'],
      legacy: [{ event: 'SessionStart', command, matcher: '^Read$', timeout: 600 }],
      rules: [
        { id: 'reminder', event: 'step.before', priority: -10, enabled: true,
          match: { models: ['example/model'], profiles: ['example'], routes: ['native'], executors: ['native'], agentRoles: ['root'], tools: ['Read'], statuses: ['success'], sources: ['user'], outcomes: ['completed'] },
          cadence: { everyCompletedSteps: 3, counterScope: 'turn', partitionBy: 'model' }, action: { type: 'inject', textFile: 'guidance/example.txt' } },
        { id: 'audit', event: 'turn.after', priority: 200, enabled: false, match: {}, action: { type: 'observe' } },
        { id: 'greeting', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Example guidance' } },
      ],
    };
    const before = await readFile(join(home as string, 'config.toml'), 'utf8');
    const hooks = (await getConfig()).hooks;
    expect(hooks).toEqual(expected);
    expect(sharedConfigResponseSchema.parse({ hooks }).hooks).toEqual(expected);
    expect(await readFile(join(home as string, 'config.toml'), 'utf8')).toBe(before);
    expect((await patchConfig(sharedPatchConfigRequestSchema.parse({ hooks }))).hooks).toEqual(expected);
    expect((await getConfig()).hooks).toEqual(expected);
    const stored = await readFile(join(home as string, 'config.toml'), 'utf8');
    expect(stored).toContain('text_file');
    expect(stored).toContain('every_completed_steps');
    expect(stored).toContain('agent_roles');
    await server!.close();
    server = undefined;
    await boot();
    expect((await getConfig()).hooks).toEqual(expected);
    expect(await readFile(marker, 'utf8').catch(() => undefined)).toBeUndefined();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('preserves legacy hooks, edits v2 rules, rejects invalid saves and switches shapes through REST', async () => {
    const trigger = vi.spyOn(ExternalHooksRunnerService.prototype, 'trigger');
    await boot('[[hooks]]\nevent = "PreToolUse"\ncommand = "echo example"\nmatcher = "^Read$"\ntimeout = 600\n');
    const legacy = [{ event: 'PreToolUse', command: 'echo example', matcher: '^Read$', timeout: 600 }];
    expect((await getConfig()).hooks).toEqual(legacy);
    expect((await patchConfig({ hooks: [{ ...legacy[0], timeout: 1 }] })).hooks).toEqual([{ ...legacy[0], timeout: 1 }]);
    const first = (await patchConfig({ hooks: { schemaVersion: 2, rules: [
      { id: 'reminder', event: 'prompt.submit', action: { type: 'inject', text: 'Example guidance' } },
      { id: 'audit', event: 'turn.after', action: { type: 'observe' } },
    ], legacy } })).hooks;
    expect(first).toEqual({ schemaVersion: 2, enabled: true, disabled: [], files: [], legacy, rules: [
      { id: 'reminder', event: 'prompt.submit', priority: 100, enabled: true, match: {}, action: { type: 'inject', text: 'Example guidance' } },
      { id: 'audit', event: 'turn.after', priority: 100, enabled: true, match: {}, action: { type: 'observe' } },
    ] });
    const edited = HooksConfigSchema.parse({ schemaVersion: 2, enabled: false, rules: [{ id: 'reminder', event: 'prompt.submit', action: { type: 'inject', text: 'Edited guidance' } }] });
    expect((await patchConfig({ hooks: edited })).hooks).toEqual(edited);
    expect((await getConfig()).hooks).toEqual(edited);
    const path = join(home as string, 'config.toml');
    const before = await readFile(path, 'utf8');
    for (const hooks of [null, {}, { schemaVersion: 2, unknown: true }, { schemaVersion: 2, rules: [{ id: 'invalid', event: 'step.before', action: { type: 'command', command: 'echo example' } }] }, { schemaVersion: 2, rules: [{ id: 'invalid', event: 'turn.after', action: { type: 'inject', text: 'example' } }] }, [{ event: 'PreToolUse', command: 'echo example', timeout: 601 }]]) {
      const response = await authedFetch(server as RunningServer, base, '/api/config', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hooks }),
      });
      expect((await response.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect((await getConfig()).hooks).toEqual(edited);
    }
    expect((await patchConfig({ hooks: legacy })).hooks).toEqual(legacy);
    expect((await getConfig()).hooks).toEqual(legacy);
    expect((await patchConfig({ hooks: [] })).hooks).toEqual([]);
    expect((await getConfig()).hooks).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('restores a space-local override through REST without changing the main space', async () => {
    const main = home as string;
    const child = join(main, 'space');
    await mkdir(child);
    await writeFile(join(main, 'config.toml'), 'default_permission_mode = "auto"\n');
    await writeFile(join(child, 'home.toml'), `schema = 1\nid = "h-restore"\nname = "Restored"\nbase = ${JSON.stringify(main)}\n`);
    await boot('default_permission_mode = "yolo"\n', child);
    expect((await getConfig()).default_permission_mode).toBe('yolo');
    const res = await authedFetch(server as RunningServer, base, '/api/config/overrides:remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'default_permission_mode', key_path: [] }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as Envelope<ConfigResponse>;
    expect(result.code).toBe(0);
    expect(result.data.default_permission_mode).toBe('auto');
    expect((await readFile(join(main, 'config.toml'), 'utf-8'))).toBe('default_permission_mode = "auto"\n');
    expect(await readFile(join(child, 'config.toml'), 'utf-8')).not.toContain('default_permission_mode');
  });

  it('persists ordered permission rules and dangerous Bash without dropping reviewer config', async () => {
    await boot();
    const first = await patchConfig({ permission: {
      rules: [
        { decision: 'deny', pattern: 'Bash(rm -rf*)', reason: 'Keep files' },
        { decision: 'ask', pattern: 'Bash', scope: 'user' },
      ],
      dangerous_bash: 'on',
    } });
    expect(first.permission).toMatchObject({
      dangerousBash: 'on', rules: [
        { decision: 'deny', pattern: 'Bash(rm -rf*)', scope: 'user', reason: 'Keep files' },
        { decision: 'ask', pattern: 'Bash', scope: 'user' },
      ],
    });
    const path = join(home as string, 'config.toml');
    expect(await readFile(path, 'utf8')).toContain('dangerous_bash = "on"');
    expect(await readFile(path, 'utf8')).toContain('[[permission.rules]]');
    expect((await getConfig()).permission?.rules?.map((rule) => rule.pattern)).toEqual(['Bash(rm -rf*)', 'Bash']);
    const updated = await patchConfig({ permission: { rules: [{ decision: 'allow', pattern: 'Read' }] } });
    expect(updated.permission?.dangerousBash).toBe('on');
    expect(updated.permission?.rules?.map((rule) => rule.pattern)).toEqual(['Read']);
    await patchConfig({ permission: { rules: [] } });
    expect((await getConfig()).permission?.rules).toEqual([]);
    expect(await readFile(path, 'utf8')).not.toContain('[[permission.rules]]');
    const before = await readFile(path, 'utf8');
    const invalid = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permission: { rules: [{ decision: 'allow', pattern: 'Bash(broken' }] } }),
    });
    expect((await invalid.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('round trips prompt variable names, merges references, validates saves and removes replaced entries', async () => {
    await boot();
    const prompt = { overrides: { fields: { 'system.shared': 'Shared ${team_note}', 'tool.web-search.guidance': '${search_guidance}' } }, variables: { team_note: 'Team note', search_guidance: 'Use native GMA SSE.' } };
    expect((await patchConfig({ prompt })).prompt).toEqual(prompt);
    expect((await getConfig()).prompt).toEqual(prompt);
    expect((await patchConfig({ prompt: { overrides: { fields: { 'tool.fetch-url.guidance': '${team_note}' } } } })).prompt?.overrides?.fields).toEqual({ 'system.shared': 'Shared ${team_note}', 'tool.web-search.guidance': '${search_guidance}', 'tool.fetch-url.guidance': '${team_note}' });
    const path = join(home as string, 'config.toml');
    const before = await readFile(path, 'utf8');
    expect(before).toContain('search_guidance');
    expect(before).toContain('web-search');
    for (const invalid of [
      { variables: { cwd: 'override' } },
      { overrides: { fields: { 'system.shared': '${missing}' } } },
      { variables: { 'bad-name': 'text' } },
      { overrides: { fields: { 'system.unknown': 'text' } } },
      { overrides: { fields: { 'system.shared': '${missing' } } },
    ]) {
      const response = await authedFetch(server as RunningServer, base, '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: invalid }) });
      expect((await response.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(await readFile(path, 'utf8')).toBe(before);
    }
    expect((await patchConfig({ prompt: {}, replace_domains: ['prompt'] })).prompt).toEqual({});
    expect((await getConfig()).prompt).toEqual({});
  });

  it('round trips the session_title model pin through its replace-domain', async () => {
    await boot();
    const pinned = await patchConfig({ session_title: { model: 'kimi-for-coding' }, replace_domains: ['session_title'] });
    expect(pinned.session_title).toEqual({ model: 'kimi-for-coding' });
    expect((await getConfig()).session_title).toEqual({ model: 'kimi-for-coding' });
    const moments = { model: 'kimi-for-coding', triggers: ['first_user_message', 'context_compacted'] };
    for (const schema of [sharedConfigResponseSchema, sharedPatchConfigRequestSchema]) expect(schema.parse({ session_title: moments }).session_title).toEqual(moments);
    expect((await patchConfig({ session_title: moments, replace_domains: ['session_title'] })).session_title).toEqual(moments);
    expect((await getConfig()).session_title).toEqual(moments);
    expect((await patchConfig({ session_title: { model: 'kimi-for-coding', triggers: [] }, replace_domains: ['session_title'] })).session_title).toEqual({ model: 'kimi-for-coding', triggers: [] });
    expect((await getConfig()).session_title?.triggers).toEqual([]);
    const cleared = await patchConfig({ session_title: {}, replace_domains: ['session_title'] });
    expect(cleared.session_title?.model).toBeUndefined();
    expect((await getConfig()).session_title?.model).toBeUndefined();
  });

  it('round trips board storage modes and subagent limits without retaining a stale fixed path', async () => {
    await boot();
    const fixed = await patchConfig({ task_board: { storage: { mode: 'fixed', path: 'ordinary/board-data' } }, subagent: { timeout_ms: 0, max_direct_children: 16, max_total_subagents: 0 } });
    expect(fixed.task_board).toEqual({ storage: { mode: 'fixed', path: 'ordinary/board-data' } });
    expect(fixed.subagent).toMatchObject({ timeoutMs: 0, maxDirectChildren: 16, maxTotalSubagents: 0 });
    expect((await patchConfig({ task_board: { storage: { mode: 'global' } } })).task_board).toEqual({ storage: { mode: 'global' } });
    expect((await patchConfig({ task_board: { storage: { mode: 'auto' } } })).task_board).toEqual({ storage: { mode: 'auto' } });
    const saved = await readFile(join(home as string, 'config.toml'), 'utf8');
    expect(saved).not.toContain('ordinary/board-data');
    const invalid = await authedFetch(server as RunningServer, base, '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_board: { storage: { mode: 'fixed', path: '' } } }) });
    expect((await invalid.json() as Envelope<unknown>).code).not.toBe(0);
    expect((await getConfig()).task_board).toEqual({ storage: { mode: 'auto' } });
  });

  it('omits legacy telemetry config and rejects telemetry patches without persisting them', async () => {
    await boot('telemetry = true\n');
    expect(await getConfig()).not.toHaveProperty('telemetry');
    const configPath = join(home as string, 'config.toml');
    const before = await readFile(configPath, 'utf-8');

    const res = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetry: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('round-trips nb_search patches and rejects persisted credential values', async () => {
    await boot();
    const config = await patchConfig({
      nb_search: {
        credential_slots: {
          'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
        },
        provider_instances: {
          'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 600_000 },
        },
        defaults: { search_lane: 'exa.search' },
        execution: { search_timeout_ms: 15_000, fetch_timeout_ms: 20_000 },
      },
      replace_domains: ['nb_search'],
    });
    expect(config.nb_search).toEqual({
      credential_slots: {
        'exa.default': { provider_id: 'exa', env: 'TEAM_EXA_API_KEY' },
      },
      provider_instances: {
        'tavily.default': { key_strategy: 'priority', balance_ttl_ms: 600_000 },
      },
      defaults: { search_lane: 'exa.search' },
      execution: { search_timeout_ms: 15_000, fetch_timeout_ms: 20_000 },
    });
    const configPath = join(home as string, 'config.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).toContain('[nb_search.defaults]');
    expect(before).toContain('env = "TEAM_EXA_API_KEY"');
    expect(before).toContain('key_strategy = "priority"');
    expect(before).toContain('balance_ttl_ms = 600000');

    const response = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nb_search: {
          credential_slots: {
            'exa.default': {
              provider_id: 'exa',
              env: 'TEAM_EXA_API_KEY',
              value: 'secret-value',
            },
          },
        },
      }),
    });
    const body = (await response.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);

    const optionResponse = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nb_search: {
          provider_instances: {
            'openai-compatible.default': { options: { token: 'secret-value' } },
          },
        },
      }),
    });
    const optionBody = (await optionResponse.json()) as Envelope<null>;
    expect(optionBody.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect(JSON.stringify(await getConfig())).not.toContain('secret-value');
    expect(before).not.toContain('secret-value');
  });

  it('GET echoes default_permission_mode and derives yolo = false', async () => {
    await boot('default_permission_mode = "auto"\n');
    const cfg = await getConfig();
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);
  });

  it('POST { yolo: true } sets default_permission_mode = yolo and echoes yolo = true', async () => {
    await boot();
    const cfg = await patchConfig({ yolo: true });
    expect(cfg.default_permission_mode).toBe('yolo');
    expect(cfg.yolo).toBe(true);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('yolo');
    expect(after.yolo).toBe(true);
  });

  it('POST { default_permission_mode: auto } writes the canonical field and derives yolo = false', async () => {
    await boot();
    const cfg = await patchConfig({ default_permission_mode: 'auto' });
    expect(cfg.default_permission_mode).toBe('auto');
    expect(cfg.yolo).toBe(false);

    const after = await getConfig();
    expect(after.default_permission_mode).toBe('auto');
    expect(after.yolo).toBe(false);
  });

  it('reads and patches the global plan gate configuration', async () => {
    await boot('[plan]\ngate = "free"\nenter_approval_timeout_ms = 60000\n');
    expect((await getConfig()).plan).toEqual({
      gate: 'free',
      enterApprovalTimeoutMs: 60_000,
    });

    const patched = await patchConfig({
      plan: { gate: 'gated', enter_approval_timeout_ms: 5000 },
    });
    expect(patched.plan).toEqual({
      gate: 'gated',
      enterApprovalTimeoutMs: 5000,
    });
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).toContain(
      'enter_approval_timeout_ms = 5000',
    );
  });

  it('GET omits request_identity when no global layer is authored', async () => {
    await boot();
    expect(await getConfig()).not.toHaveProperty('request_identity');
  });

  it('GET returns the sparse authored global request_identity without expansion', async () => {
    await boot([
      '[request_identity.overrides.client]',
      'user_agent = "host"',
      '',
    ].join('\n'));

    expect((await getConfig()).request_identity).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });
  });

  it('PATCH replaces, preserves on omission, and clears the authored global request_identity', async () => {
    await boot();
    const first = await patchConfig({
      request_identity: { overrides: { client: { user_agent: 'host' } } },
      replace_domains: ['request_identity'],
    });
    expect(first.request_identity).toEqual({
      overrides: { client: { user_agent: 'host' } },
    });

    const omitted = await patchConfig({ builtin_product_skills: true });
    expect(omitted.request_identity).toEqual(first.request_identity);

    const replaced = await patchConfig({
      request_identity: { overrides: { cache: { responses: 'none' } } },
    });
    expect(replaced.request_identity).toEqual({
      overrides: { cache: { responses: 'none' } },
    });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('[request_identity.overrides.cache]');
    expect(persisted).not.toContain('user_agent');

    const cleared = await patchConfig({ request_identity: null });
    expect(cleared).not.toHaveProperty('request_identity');
    expect(await getConfig()).not.toHaveProperty('request_identity');
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).not.toContain(
      '[request_identity',
    );
  });

  it('rejects empty authored global request_identity layers', async () => {
    await boot();
    for (const request_identity of [{}, { overrides: {} }, { overrides: { client: {} } }]) {
      const res = await authedFetch(server as RunningServer, base, '/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request_identity }),
      });
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('POST persists GUI server settings through the config service without dropping other domains', async () => {
    await boot([
      '[providers.example]',
      'type = "openai"',
      'api_key = "secret-kept"',
      '',
    ].join('\n'));

    const cfg = await patchConfig({
      subagent: { timeout_ms: 60_000, deny_models: ['example/blocked'] },
      agents: { enabled: false },
      builtin_product_skills: false,
      image: { max_edge_px: 2048 },
    });

    expect(cfg.subagent).toEqual({ timeoutMs: 60_000, denyModels: ['example/blocked'] });
    expect(cfg.agents).toEqual({ enabled: false, notify_parent: true });
    expect(cfg.builtin_product_skills).toBe(false);
    expect(cfg.image?.maxEdgePx).toBe(2048);

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).not.toContain('api_key');
    expect(persisted).toContain('timeout_ms = 60000');
    expect(persisted).toContain('max_edge_px = 2048');
    expect(await readCredentialsFile()).toContain('api_key = "secret-kept"');
  });

  it('round-trips the subagent default_profile, including the strict empty string', async () => {
    await boot();

    const named = await patchConfig({ subagent: { default_profile: 'explore' } });
    expect(named.subagent?.defaultProfile).toBe('explore');
    expect((await getConfig()).subagent?.defaultProfile).toBe('explore');
    let persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('default_profile = "explore"');

    const strict = await patchConfig({ subagent: { default_profile: '' } });
    expect(strict.subagent?.defaultProfile).toBe('');
    expect((await getConfig()).subagent?.defaultProfile).toBe('');
    persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('default_profile = ""');
  });

  it('round-trips the subagent allowed_tools and clears it back while keeping other fields', async () => {
    await boot();

    await patchConfig({ subagent: { timeout_ms: 60_000, default_profile: 'explore' } });
    const allowed = await patchConfig({ subagent: { allowed_tools: ['BoardRead'] } });
    expect(allowed.subagent).toMatchObject({ timeoutMs: 60_000, defaultProfile: 'explore', allowedTools: ['BoardRead'] });
    expect((await getConfig()).subagent?.allowedTools).toEqual(['BoardRead']);
    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toMatch(/allowed_tools\s*=\s*\[\s*"BoardRead"\s*\]/);

    const cleared = await patchConfig({ subagent: { allowed_tools: [] } });
    expect(cleared.subagent).toMatchObject({ timeoutMs: 60_000, defaultProfile: 'explore', allowedTools: [] });
    expect((await getConfig()).subagent).toMatchObject({ timeoutMs: 60_000, defaultProfile: 'explore', allowedTools: [] });
  });

  it('validates and round-trips the subagent default_model and top-level fast_model', async () => {
    await boot('[models."explore/fast"]\nprovider = "openai"\nmodel = "fast"\n[models."kimi-code/kimi-k2"]\nprovider = "openai"\nmodel = "kimi-k2"\n');
    const events: ConfigChanged[] = [];
    const subscription = (server as RunningServer).core.accessor
      .get(IEventService)
      .onDidPublish((event) => { if (event instanceof ConfigChanged) events.push(event); });

    try {
      for (const patch of [{ fast_model: 'missing-model' }, { subagent: { default_model: 'missing-model' } }]) {
        const res = await authedFetch(server as RunningServer, base, '/api/config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        });
        const invalid = await res.json() as Envelope<unknown>;
        expect(invalid.code).toBe(ErrorCode.MODEL_NOT_FOUND);
        expect(invalid.msg).toContain('unknown model alias');
      }
      expect(events).toHaveLength(0);
      expect((await getConfig()).fast_model).toBeUndefined();
      const set = await patchConfig({
        subagent: { default_model: 'explore/fast', timeout_ms: 60_000 },
        fast_model: 'kimi-code/kimi-k2',
      });
      expect(set.subagent).toMatchObject({ defaultModel: 'explore/fast', timeoutMs: 60_000 });
      expect(set.fast_model).toBe('kimi-code/kimi-k2');

      const after = await getConfig();
      expect(after.subagent?.defaultModel).toBe('explore/fast');
      expect(after.fast_model).toBe('kimi-code/kimi-k2');

      const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
      expect(persisted).toContain('default_model = "explore/fast"');
      expect(persisted).toContain('fast_model = "kimi-code/kimi-k2"');

      const published = events.at(-1);
      expect(published?.payload.changedFields).toEqual(expect.arrayContaining(['subagent', 'fast_model']));
      expect(published?.payload.config).toMatchObject({
        subagent: { defaultModel: 'explore/fast' },
        fast_model: 'kimi-code/kimi-k2',
      });

      const cleared = await patchConfig({ subagent: { default_model: null }, fast_model: null });
      expect(cleared.subagent?.defaultModel).toBeUndefined();
      expect(cleared.subagent?.timeoutMs).toBe(60_000);
      expect(cleared.fast_model).toBeUndefined();

      const clearedAgain = await getConfig();
      expect(clearedAgain.subagent?.defaultModel).toBeUndefined();
      expect(clearedAgain.fast_model).toBeUndefined();

      const clearedText = await readFile(join(home as string, 'config.toml'), 'utf-8');
      expect(clearedText).not.toContain('default_model');
      expect(clearedText).not.toContain('fast_model');
      expect(clearedText).toContain('timeout_ms = 60000');
    } finally {
      subscription.dispose();
    }
  });

  it('preserves the Kimi Code compatibility flag across partial identity patches', async () => {
    await boot('[identity]\nadvertise_as_kimi_code = true\n');

    const after = await patchConfig({ identity: { name: 'Example Agent' } });

    expect(after.identity).toEqual({
      name: 'Example Agent',
      advertiseAsKimiCode: true,
    });
  });

  it('round-trips every persistable GUI runtime domain through config.toml', async () => {
    await boot();

    await patchConfig({
      thread_communication: { enabled: true },
      token_counting: { strategy: 'measured' },
      workspace_instance: { idle_ttl_ms: 12_345 },
      image: { max_edge_px: 1_024, read_byte_budget: 2_000_000 },
      task: {
        max_running_tasks: 3,
        keep_alive_on_exit: true,
        bash_auto_background_on_timeout: true,
        bash_task_timeout_s: 45,
        kill_grace_period_ms: 2_500,
        print_wait_ceiling_s: 30,
        print_background_mode: 'drain',
        print_max_turns: 12,
      },
      identity: {
        name: 'Example Agent',
        slug: 'example-agent',
        advertise_as_kimi_code: true,
      },
      extra_agent_dirs: ['/tmp/example-agents', '/tmp/team-agents'],
      skip_builtin_profile_installation: ['researcher', 'reviewer'],
      disabled_named_profiles: ['reviewer'],
      mcp: { startup_timeout_ms: 5_000, tool_timeout_ms: 6_000 },
      tools: { enabled: ['Read', 'Write'], disabled: ['Bash'] },
      replace_domains: [
        'thread_communication',
        'token_counting',
        'workspace_instance',
        'image',
        'task',
        'identity',
        'extra_agent_dirs',
        'skip_builtin_profile_installation',
        'disabled_named_profiles',
        'mcp',
        'tools',
      ],
    });

    await server?.close();
    server = undefined;
    await boot();

    const after = await getConfig();
    expect(after.thread_communication).toEqual({ enabled: true });
    expect(after.token_counting).toEqual({ strategy: 'measured' });
    expect(after.workspace_instance).toEqual({ idleTtlMs: 12_345 });
    expect(after.image).toEqual({ maxEdgePx: 1_024, readByteBudget: 2_000_000 });
    expect(after.task).toEqual({
      maxRunningTasks: 3,
      keepAliveOnExit: true,
      bashAutoBackgroundOnTimeout: true,
      bashTaskTimeoutS: 45,
      killGracePeriodMs: 2_500,
      printWaitCeilingS: 30,
      printBackgroundMode: 'drain',
      printMaxTurns: 12,
    });
    expect(after.identity).toEqual({
      name: 'Example Agent',
      slug: 'example-agent',
      advertiseAsKimiCode: true,
    });
    expect(after.extra_agent_dirs).toEqual(['/tmp/example-agents', '/tmp/team-agents']);
    expect(after.skip_builtin_profile_installation).toEqual(['researcher', 'reviewer']);
    expect(after.disabled_named_profiles).toEqual(['reviewer']);
    expect(after.mcp).toEqual({ startupTimeoutMs: 5_000, toolTimeoutMs: 6_000 });
    expect(after.tools).toEqual({ enabled: ['Read', 'Write'], disabled: ['Bash'] });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('[thread_communication]');
    expect(persisted).toContain('idle_ttl_ms = 12345');
    expect(persisted).toContain('read_byte_budget = 2000000');
    expect(persisted).toContain('print_background_mode = "drain"');
    expect(persisted).toContain('startup_timeout_ms = 5000');
  });

  it('replace_domains removes omitted runtime fields and clears list domains', async () => {
    await boot([
      'extra_agent_dirs = ["/tmp/example-agents", "/tmp/old-agents"]',
      'skip_builtin_profile_installation = ["researcher", "reviewer"]',
      'disabled_named_profiles = ["reviewer"]',
      '',
      '[thread_communication]',
      'enabled = true',
      '',
      '[token_counting]',
      'strategy = "measured"',
      '',
      '[workspace_instance]',
      'idle_ttl_ms = 12345',
      '',
      '[image]',
      'max_edge_px = 1024',
      'read_byte_budget = 2000000',
      '',
      '[task]',
      'max_running_tasks = 3',
      'keep_alive_on_exit = true',
      'print_background_mode = "drain"',
      'print_max_turns = 12',
      '',
      '[identity]',
      'name = "Old Agent"',
      'slug = "old-agent"',
      '',
      '[mcp]',
      'startup_timeout_ms = 5000',
      'tool_timeout_ms = 6000',
      '',
      '[tools]',
      'enabled = ["Read", "Write"]',
      'disabled = ["Bash"]',
      '',
    ].join('\n'));

    const after = await patchConfig({
      thread_communication: { enabled: false },
      token_counting: { strategy: 'estimated' },
      workspace_instance: {},
      image: { max_edge_px: 2_048 },
      task: { keep_alive_on_exit: false, print_background_mode: 'exit' },
      identity: { name: 'Example Agent' },
      extra_agent_dirs: ['/tmp/example-agents'],
      skip_builtin_profile_installation: [],
      disabled_named_profiles: [],
      mcp: { tool_timeout_ms: 7_000 },
      tools: { enabled: ['Write'] },
      replace_domains: [
        'thread_communication',
        'token_counting',
        'workspace_instance',
        'image',
        'task',
        'identity',
        'extra_agent_dirs',
        'skip_builtin_profile_installation',
        'disabled_named_profiles',
        'mcp',
        'tools',
      ],
    });

    expect(after.thread_communication).toEqual({ enabled: false });
    expect(after.token_counting).toEqual({ strategy: 'estimated' });
    expect(after.workspace_instance).toEqual({ idleTtlMs: 300_000 });
    expect(after.image).toEqual({ maxEdgePx: 2_048 });
    expect(after.task).toEqual({ keepAliveOnExit: false, printBackgroundMode: 'exit' });
    expect(after.identity).toEqual({ name: 'Example Agent', advertiseAsKimiCode: false });
    expect(after.extra_agent_dirs).toEqual(['/tmp/example-agents']);
    expect(after.skip_builtin_profile_installation).toEqual([]);
    expect(after.disabled_named_profiles).toEqual([]);
    expect(after.mcp).toEqual({ toolTimeoutMs: 7_000 });
    expect(after.tools).toEqual({ enabled: ['Write'] });

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).not.toContain('idle_ttl_ms');
    expect(persisted).not.toContain('read_byte_budget');
    expect(persisted).not.toContain('max_running_tasks');
    expect(persisted).not.toContain('print_max_turns');
    expect(persisted).not.toContain('slug =');
    expect(persisted).not.toContain('startup_timeout_ms');
    expect(persisted).not.toContain('disabled = ["Bash"]');
    expect(persisted).not.toContain('/tmp/old-agents');
    expect(persisted).not.toContain('"researcher"');
  });

  it('PATCH a disabled list domain without replace_domains replaces the array atomically', async () => {
    await boot([
      'skip_builtin_profile_installation = ["coder"]',
      'disabled_named_profiles = ["critic"]',
      '',
    ].join('\n'));

    const first = await patchConfig({ skip_builtin_profile_installation: ['explore', 'agent'] });
    expect(first.skip_builtin_profile_installation).toEqual(['explore', 'agent']);
    expect(first.disabled_named_profiles).toEqual(['critic']);

    const second = await patchConfig({ skip_builtin_profile_installation: ['agent'] });
    expect(second.skip_builtin_profile_installation).toEqual(['agent']);

    const after = await getConfig();
    expect(after.skip_builtin_profile_installation).toEqual(['agent']);
    expect(after.disabled_named_profiles).toEqual(['critic']);

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('"agent"');
    expect(persisted).toContain('"critic"');
    expect(persisted).not.toContain('"coder"');
    expect(persisted).not.toContain('"explore"');
  });

  it('retains the last good configuration while an external editor writes an incomplete document', async () => {
    await boot('default_permission_mode = "auto"\n');
    const configPath = join(home as string, 'config.toml');
    const config = server!.core.accessor.get(IConfigService);
    await writeFile(configPath, 'default_permission_mode = "');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect((await getConfig()).default_permission_mode).toBe('auto');
    expect(config.diagnostics().some((diagnostic) => diagnostic.severity === 'error')).toBe(false);
    await writeFile(configPath, 'default_permission_mode = "yolo"\n');
    await vi.waitFor(() => { expect(config.get('defaultPermissionMode')).toBe('yolo'); }, { timeout: 5000 });
    await writeFile(configPath, '');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(config.get('defaultPermissionMode')).toBe('yolo');
    await writeFile(configPath, 'default_permission_mode = "auto"\n');
    await vi.waitFor(() => { expect(config.get('defaultPermissionMode')).toBe('auto'); }, { timeout: 5000 });
  });

  it('hot reloads external governance additions, edits and removals into running admission', async () => {
    await boot('default_permission_mode = "auto"\n');
    const configPath = join(home as string, 'config.toml');
    const governor = server!.core.accessor.get(IRequestGovernance);
    let next = 0;
    const attempt = (): RequestAttempt => ({
      logicalRequestId: `request-${next}`, attemptId: `attempt-${next++}`,
      modelId: 'example/model-a', providerId: 'example-provider',
      sessionId: `session-${next}`, agentId: 'main', purpose: 'turn', waitBudget: { waitedMs: 0 },
    });
    const first = await Promise.all(Array.from({ length: 4 }, () => governor.acquire(attempt())));
    expect(governor.snapshot()).toMatchObject({ active: 4, queued: 0 });
    first.pop()!.release();
    const toml = (cap: number) => `default_permission_mode = "yolo"\n[request_governance]\n[[request_governance.rules]]\nid = "example-global-cap"\nscope = "global"\nmodels = ["example/model-a", "example/model-b"]\nmax_concurrent = ${cap}\noverflow = "queue"\n`;
    await writeFile(configPath, toml(3));
    await vi.waitFor(() => { expect(governor.snapshot().rules[0]?.maxConcurrent).toBe(3); }, { timeout: 5000 });
    expect((await getConfig()).default_permission_mode).toBe('yolo');
    const active = first;
    const fourth = governor.acquire(attempt());
    expect(governor.snapshot()).toMatchObject({ active: 3, queued: 1 });
    await writeFile(`${configPath}.editor-save`, toml(4));
    await rename(`${configPath}.editor-save`, configPath);
    await vi.waitFor(() => { expect(governor.snapshot()).toMatchObject({ active: 4, queued: 0 }); }, { timeout: 5000 });
    const fourthPermit = await fourth;
    await writeFile(configPath, toml(1));
    await vi.waitFor(() => { expect(governor.snapshot().rules[0]?.maxConcurrent).toBe(1); }, { timeout: 5000 });
    const fifth = governor.acquire(attempt());
    expect(governor.snapshot()).toMatchObject({ active: 4, queued: 1 });
    await writeFile(configPath, 'default_permission_mode = "auto"\n');
    await vi.waitFor(() => { expect(governor.snapshot()).toMatchObject({ active: 5, queued: 0, rules: [] }); }, { timeout: 5000 });
    (await fifth).release();
    fourthPermit.release();
    active.forEach((permit) => { permit.release(); });
  });

  it('writes request_governance rules through POST /config, live for the realtime route, replacing the rule list atomically', async () => {
    await boot();
    const configPath = join(home as string, 'config.toml');
    const rules = [
      { id: 'provider-cap', scope: 'global', providers: ['provider-a'], max_concurrent: 3, overflow: 'queue' },
      { id: 'session-cap', scope: 'each_session', max_concurrent: 1, overflow: 'reject', subagents_only: true, enabled: false },
    ];
    const config = server!.core.accessor.get(IConfigService);
    const changes: string[] = [];
    const subscription = config.onDidChangeConfiguration((event) => {
      if (event.domain === 'requestGovernance') changes.push(event.source);
    });
    await patchConfig({ request_governance: { rules } });
    const sequence = server!.core.accessor.get(IRequestGovernance).snapshot().seq;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(changes).toEqual(['set']);
    expect(server!.core.accessor.get(IRequestGovernance).snapshot().seq).toBe(sequence);
    subscription.dispose();

    const persisted = await readFile(configPath, 'utf-8');
    expect(persisted).toContain('[[request_governance.rules]]');
    expect(persisted).toContain('max_concurrent = 3');
    expect(persisted).toContain('enabled = false');

    const realtime = await authedFetch(server as RunningServer, base, '/api/usage/realtime');
    expect(realtime.status).toBe(200);
    const snapshot = (await realtime.json()) as Envelope<{ rules: Record<string, unknown>[] }>;
    expect(snapshot.code).toBe(0);
    expect(snapshot.data.rules).toEqual([
      expect.objectContaining({ id: 'provider-cap', maxConcurrent: 3, enabled: true }),
      expect.objectContaining({ id: 'session-cap', scope: 'each_session', subagentsOnly: true, enabled: false }),
    ]);

    await patchConfig({ request_governance: { rules: [rules[0]] } });
    expect(await readFile(configPath, 'utf-8')).not.toContain('session-cap');

    const before = await readFile(configPath, 'utf-8');
    const invalid = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_governance: { rules: [{ id: 'dup' }, { id: 'dup' }] } }),
    });
    expect((await invalid.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    const unknownKey = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_governance: { rules: [{ id: 'cap', max_concurrency: 2 }] } }),
    });
    expect((await unknownKey.json() as Envelope<unknown>).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
  });

  it('rejects unknown retry keys without persisting them', async () => {
    await boot('[retry]\nmax_attempts = 2\n');
    const configPath = join(home as string, 'config.toml');
    const before = await readFile(configPath, 'utf-8');

    const res = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ retry: { max_attempt: 3 } }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(await readFile(configPath, 'utf-8')).toBe(before);
    expect((await getConfig()).retry).toEqual({ maxAttempts: 2 });
  });

  it('saves executor overrides and preserves executor ids and environment variable names', async () => {
    await boot();
    await patchConfig({ agent_executor_overrides: { example_acp: {
      bin_path: 'adapter.js', home_dir: 'adapter-home', args: ['--verbose'],
      env: { example_model: 'model-a', EXAMPLE_BASE_URL: 'https://example.test' },
    } } });
    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(persisted).toContain('agent_executor_overrides.example_acp');
    expect(persisted).toContain('home_dir = "adapter-home"');
    expect(persisted).toContain('example_model = "model-a"');
    expect(persisted).toContain('EXAMPLE_BASE_URL = "https://example.test"');
    await patchConfig({ agent_executor_overrides: { example_acp: { home_dir: null, env: { example_model: null } } } });
    const cleared = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(cleared).not.toContain('home_dir');
    expect(cleared).not.toContain('example_model');
    expect(cleared).toContain('bin_path = "adapter.js"');
  });

  it('validates every runtime domain with the core schemas and rejects unknown top-level fields', async () => {
    await boot();

    const invalidPatches: Record<string, unknown>[] = [
      { thread_communication: { enabled: 'yes' } },
      { token_counting: { strategy: 'approximate' } },
      { plan: { enter_approval_timeout_ms: 4999 } },
      { workspace_instance: { idle_ttl_ms: -1 } },
      { image: { max_edge_px: 0 } },
      { task: { max_running_tasks: 0 } },
      { identity: { name: 42 } },
      { extra_agent_dirs: [42] },
      { skip_builtin_profile_installation: [42] },
      { disabled_named_profiles: [42] },
      { mcp: { startup_timeout_ms: 0 } },
      { tools: { enabled: [42] } },
      { agent_executor_overrides: { example_acp: { args: [42] } } },
      { agent_executor_overrides: { example_acp: { unexpected_option: true } } },
      { unknown_runtime_domain: { enabled: true } },
    ];

    for (const patch of invalidPatches) {
      const res = await authedFetch(server as RunningServer, base, '/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('keeps cron operational settings non-writable through POST /config', async () => {
    await boot();

    for (const patch of [
      { cron: { disabled: true } },
      { replace_domains: ['cron'] },
    ]) {
      const res = await authedFetch(server as RunningServer, base, '/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Envelope<null>;
      expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
    }

    const after = await getConfig();
    expect(after.cron).toEqual({
      debug: false,
      noJitter: false,
      noStale: false,
      disabled: false,
      manualTick: false,
    });
  });

  it('serializes concurrent config patches so disjoint fields do not overwrite each other', async () => {
    await boot('[agents]\nenabled = true\n');

    await Promise.all([
      patchConfig({ agents: { enabled: false } }),
      patchConfig({ image: { max_edge_px: 2048 } }),
      patchConfig({ subagent: { deny_models: ['provider/blocked'] } }),
    ]);

    const after = await getConfig();
    expect(after.agents).toEqual({ enabled: false, notify_parent: true });
    expect(after.subagent?.denyModels).toEqual(['provider/blocked']);
    expect(after.image?.maxEdgePx).toBe(2048);
  });

  it('no longer exposes or accepts the model catalog refresh config domain', async () => {
    await boot();

    expect(await getConfig()).not.toHaveProperty('model_catalog');

    const res = await authedFetch(server as RunningServer, base, '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_catalog: { refresh_on_start: true } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);

    const persisted = await readFile(join(home as string, 'config.toml'), 'utf-8').catch(() => '');
    expect(persisted).not.toContain('model_catalog');
  });

  it('replace_domains lets GUI list editors delete pool and experimental map entries', async () => {
    await boot([
      '[subagent]',
      'deny_models = ["provider/blocked", "provider/old"]',
      '',
      '[experimental]',
      'alpha = true',
      'beta = false',
      '',
    ].join('\n'));

    const after = await patchConfig({
      subagent: { deny_models: ['provider/blocked'] },
      experimental: { alpha: false },
      replace_domains: ['experimental'],
    });

    expect(after.subagent?.denyModels).toEqual(['provider/blocked']);
    expect(after.experimental).toEqual({ alpha: false });
  });

  it('POST { providers } converts fields of a provider id colliding with a map-valued key', async () => {
    await boot();
    await patchConfig({
      providers: {
        models: { type: 'openai', base_url: 'https://example.test', api_key: 'sk-test' },
      },
    });

    const after = await getConfig();
    expect(after.providers['models']).toMatchObject({
      type: 'openai',
      base_url: 'https://example.test',
      has_api_key: true,
    });
  });

  it('migrates a legacy config.toml api_key into credentials.toml and backs up the original', async () => {
    const legacy = [
      '[providers.example]',
      'type = "openai"',
      'api_key = "legacy-secret"',
      '',
    ].join('\n');
    await boot(legacy);

    const configText = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(configText).toContain('[providers.example]');
    expect(configText).not.toContain('api_key');
    expect(configText).not.toContain('legacy-secret');
    expect(await readCredentialsFile()).toContain('api_key = "legacy-secret"');

    const backups = (await readdir(home as string)).filter((name) =>
      name.startsWith('config.toml.bak-'),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(home as string, backups[0] as string), 'utf-8')).toBe(legacy);
  });

  it('redacts provider keys from the bulk read, reveals them on request, and keeps them out of config.toml', async () => {
    await boot([
      '[providers.example]',
      'type = "openai"',
      'api_key = "legacy-secret"',
      '',
    ].join('\n'));

    const migrated = await getConfig();
    expect(migrated.providers['example']).toMatchObject({ type: 'openai', has_api_key: true });
    expect(migrated.providers['example']).not.toHaveProperty('api_key');

    const patched = await patchConfig({
      providers: {
        example: {
          type: 'openai',
          base_url: 'https://api.example.test/v1',
          api_key: 'patched-secret',
        },
      },
    });
    const patchedProvider = patched.providers['example'];
    expect(patchedProvider).toMatchObject({
      type: 'openai',
      base_url: 'https://api.example.test/v1',
      has_api_key: true,
    });
    expect(patchedProvider).not.toHaveProperty('api_key');

    const raw = await (await authedFetch(server as RunningServer, base, '/api/config')).text();
    expect(raw).not.toContain('patched-secret');
    expect(raw).not.toContain('legacy-secret');
    const revealed = await (await authedFetch(server as RunningServer, base, '/api/secrets:reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { kind: 'provider_api_key', provider_id: 'example' } }),
    })).json() as { data: { source: string; value: string } };
    expect(revealed.data).toEqual({ source: 'kiki', value: 'patched-secret' });

    const configText = await readFile(join(home as string, 'config.toml'), 'utf-8');
    expect(configText).not.toContain('api_key');
    expect(configText).not.toContain('patched-secret');
    const credentialsText = await readCredentialsFile();
    expect(credentialsText).toContain('patched-secret');
    expect(credentialsText).not.toContain('legacy-secret');
  });

  it('never echoes a model-level api_key through the config read projection', async () => {
    await boot([
      '[providers.example]',
      'type = "openai"',
      '',
      '[models.example-model]',
      'provider = "example"',
      'model = "example-model"',
      'api_key = "model-private-key"',
      '',
    ].join('\n'));

    const response = await (await authedFetch(server as RunningServer, base, '/api/config')).text();
    expect(response).toContain('example-model');
    expect(response).not.toContain('model-private-key');
    const body = JSON.parse(response) as { data: { models: Record<string, Record<string, unknown>> } };
    expect(body.data.models['example-model']).toEqual({ provider: 'example', model: 'example-model' });
    expect(await readCredentialsFile()).toContain('model-private-key');
    expect(await readFile(join(home as string, 'config.toml'), 'utf-8')).not.toContain('model-private-key');
  });

  it('serves layered config origins and follows an external base rewrite', async () => {
    const root = home as string;
    const space = join(root, 'space');
    await mkdir(space);
    await writeFile(join(root, 'config.toml'), 'default_model = "base-first"\n');
    await writeFile(join(space, 'home.toml'), `schema = 1\nid = "h-test"\nname = "Test"\nbase = "${root.replaceAll('\\', '/')}"\n`);
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: space, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    expect((await getConfig()).origins?.['default_model']?.['']).toBe('base');
    await writeFile(join(root, 'config.toml'), 'default_model = "base-second"\n');
    await expect.poll(async () => (await getConfig()).default_model).toBe('base-second');
    await patchConfig({ default_model: 'home-model' });
    expect((await getConfig()).origins?.['default_model']?.['']).toBe('home');
    expect(await readFile(join(root, 'config.toml'), 'utf8')).toContain('base-second');
    expect(await readFile(join(space, 'config.toml'), 'utf8')).toContain('home-model');
  });

  it('returns the last acknowledged rapid config write on GET and disk', async () => {
    await boot();
    let last: boolean | undefined;
    await Promise.all(Array.from({ length: 12 }, (_, index) => patchConfig({ merge_all_available_skills: index % 2 === 0 })
      .then((response) => { last = response.merge_all_available_skills; })));
    expect((await getConfig()).merge_all_available_skills).toBe(last);
    expect(await readFile(join(home as string, 'config.toml'), 'utf8')).toContain(`merge_all_available_skills = ${last}`);
  });
});
