import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parsePersonaFileText } from '@kiki/agent-profiles';

import { HooksConfigSchema, HooksV2ConfigSchema, hooksFromToml } from '#/features/externalHooks/configSection';
import { matchesHook, type EffectiveHookRule } from '#/features/externalHooks/internal/rules';
import PERSONA_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-persona/references/authoring.md?raw';
import HOOKS_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-hooks/references/authoring.md?raw';
import PLUGIN_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-plugin/references/authoring.md?raw';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { ConfigRegistry } from '#/app/config/configService';
import { applySectionToToml, transformTomlData } from '#/app/config/toml';
import { LOOP_CONTROL_SECTION, LoopControlSchema } from '#/agent/loop/configSection';
import { RequestGovernanceConfigSchema, requestGovernanceFromToml } from '#/app/requestGovernance/configSection';
import { IFlagService } from '#/app/flag/flag';
import { BUILTIN_SKILLS, visibleBuiltinSkills } from '#/app/skillCatalog/builtin/builtin';
import { EXAMPLE_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/examples/exampleAgentProfiles';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';

import { stubFlag } from '../flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

const PRODUCT_SKILLS = ['kiki-ops', 'kiki-profile', 'kiki-persona', 'kiki-hooks', 'kiki-plugin', 'kiki-appearance', 'kiki-as-subagent', 'tool-workflows'];
const KIKI_OPS_TRIGGERS = [
  'first-run',
  'provider',
  'default-model',
  'config.toml',
  'tui.toml',
  'websearch',
  'fetchurl',
  'sessions',
  'subagents',
  'background tasks',
  'requirements board',
  'approvals',
  'mcp',
  'plugins',
  'themes',
  'concurrency',
  'queued requests',
  '429',
  'hot reload',
  'usage',
  'memory maintenance',
  'effective prompts',
  'check all branches',
  'cockpit',
];
const NEUTRAL_SKILLS = BUILTIN_SKILLS.map((s) => s.name).filter(
  (name) => !PRODUCT_SKILLS.includes(name),
);

async function loadNames(configured?: boolean): Promise<readonly string[]> {
  const ix = new TestInstantiationService();
  ix.set(
    IConfigService,
    new StubConfigService(
      configured === undefined ? {} : { [BUILTIN_PRODUCT_SKILLS_SECTION]: configured },
    ),
  );
  ix.set(IFlagService, stubFlag(true));
  const source = ix.createInstance(BuiltinSkillSource);
  return (await source.load()).skills.map((s) => s.name);
}

describe('BuiltinSkillSource product-skill switch', () => {
  it('ships exactly the product-facing builtin skills', () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual(PRODUCT_SKILLS);
    expect(BUILTIN_SKILLS.every((skill) => skill.productSpecific === true)).toBe(true);
    expect(NEUTRAL_SKILLS).toEqual([]);
  });

  it.each(BUILTIN_SKILLS)('keeps $name description within 250 characters and complete in the model listing', (skill) => {
    expect(skill.description.length).toBeLessThanOrEqual(250);
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(skill);
    expect(catalog.getModelSkillListing()).toContain(`- ${skill.name}: ${skill.description}`);
  });

  it('keeps kiki-ops broad but narrowly limited to Kiki product operations', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops');
    expect(ops?.metadata.disableModelInvocation).not.toBe(true);
    expect(ops?.metadata.isSubSkill).not.toBe(true);
    expect(ops?.description.toLowerCase()).toContain('do not use for ordinary');
    expect(ops?.description).toContain('or another app');
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(ops!);
    for (const trigger of KIKI_OPS_TRIGGERS) {
      expect(catalog.getModelSkillListing().toLowerCase()).toContain(trigger);
    }
    expect(BUILTIN_SKILLS.some((skill) => skill.name.startsWith('kiki-ops.'))).toBe(false);
  });

  it('keeps kiki-profile independent and narrow', () => {
    const profile = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile');
    expect(profile?.metadata.disableModelInvocation).not.toBe(true);
    expect(profile?.metadata.isSubSkill).not.toBe(true);
    expect(profile?.description.toLowerCase()).toContain('create, modify, or repair');
    expect(profile?.description.toLowerCase()).toContain('do not use merely to select');
    expect(profile?.content).toContain('by default the body is the complete system prompt');
  });

  it.each([
    ['kiki-persona', PERSONA_REFERENCE, 'Not for selecting an existing persona'],
    ['kiki-hooks', HOOKS_REFERENCE, 'Not for ordinary tool calls'],
  ])('bundles %s authoring references and keeps its exclusion visible', (name, reference, exclusion) => {
    const skill = BUILTIN_SKILLS.find((entry) => entry.name === name)!;
    expect(skill.path).toBe(`builtin://${name}`);
    expect(skill.dir).toBe(`builtin://${name}`);
    expect(skill.metadata.isSubSkill).not.toBe(true);
    expect(skill.metadata.disableModelInvocation).not.toBe(true);
    expect(skill.content).toContain(`## references/authoring.md\n\n${reference}`);
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(skill);
    expect(catalog.getModelSkillListing()).toContain(exclusion);
  });

  it('bundles the kiki-plugin authoring reference and keeps its scope limits visible', () => {
    const plugin = BUILTIN_SKILLS.find((entry) => entry.name === 'kiki-plugin')!;
    expect(plugin.path).toBe('builtin://kiki-plugin');
    expect(plugin.dir).toBe('builtin://kiki-plugin');
    expect(plugin.metadata.isSubSkill).not.toBe(true);
    expect(plugin.metadata.disableModelInvocation).not.toBe(true);
    expect(plugin.content).toContain(`## references/authoring.md\n\n${PLUGIN_REFERENCE}`);
    const catalog = new InMemorySkillCatalog();
    catalog.registerBuiltinSkill(plugin);
    const listing = catalog.getModelSkillListing();
    expect(listing).toContain('extend a local Kiki plugin');
    expect(listing).toContain('Not for installing, enabling, or browsing plugins');
  });

  it('routes persona identity and hook authoring out of the general operations skill', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops')!.content;
    const profile = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')!.content;
    expect(ops).toContain('belongs to `kiki-persona`');
    expect(ops).toContain('belongs to `kiki-hooks`');
    expect(profile).toContain('load `kiki-persona` instead');
    const persona = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-persona')!.content;
    expect(persona).toContain('转 `kiki-profile`');
    expect(persona).toContain('保留现有模型、权限与共享记忆设置');
    expect(persona).toContain('正在进行的会话保留自己的角色快照');
    expect(persona).toContain('不手工制造角色状态、目录索引或运行时记忆');
    expect(persona).not.toMatch(/kiki persona (create|validate)/);
  });

  it('ships a loadable minimal persona without changing models, tools or shared memory', () => {
    const snippets = [...PERSONA_REFERENCE.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const definitions = snippets.filter((text) => text.startsWith('---\n')).map((text) =>
      parsePersonaFileText({ path: '/personas/writing-partner/persona.md', text }),
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ id: 'writing-partner', name: '写作伙伴', profile: 'agent' });
    expect(definitions[0]?.modelAlias).toBeUndefined();
    expect(definitions[0]?.memory).toBeUndefined();
    expect(definitions[0]?.skills).toBeUndefined();
    expect(snippets[1]?.match(/用户：/g)).toHaveLength(2);
    expect(() => parsePersonaFileText({
      path: '/personas/writing-partner/persona.md',
      text: snippets[0]!.replace('profile: agent', 'tools: [Read]'),
    })).toThrow(/permissions belong to the referenced profile/);
  });

  it('ships current v2 and explicitly legacy hooks examples with correct near-miss behavior', () => {
    const examples = [...HOOKS_REFERENCE.matchAll(/```toml\n([\s\S]*?)```/g)].map((match) =>
      HooksV2ConfigSchema.parse(hooksFromToml(parseToml(match[1]!)['hooks'])),
    );
    expect(examples).toHaveLength(3);
    const guidance = examples[0]!.rules[0]!;
    expect(guidance).toMatchObject({
      event: 'step.before', match: { agentRoles: ['root'], executors: ['native'] },
      cadence: { everyCompletedSteps: 3, counterScope: 'agent', partitionBy: 'model' },
      action: { type: 'inject' },
    });
    const observation = examples[1]!.rules[0]!;
    expect(observation).toMatchObject({ event: 'tool.after', action: { type: 'observe' } });
    const effective = (rule: typeof guidance): EffectiveHookRule => ({
      rule, id: `user/${rule.id}`, namespace: 'user', path: '/example/hooks.toml',
      mutable: true, contentHash: '', semanticHash: '', active: true,
    });
    expect(matchesHook(effective(guidance), { event: 'step.before', agentRole: 'root', executorId: 'native' })).toBe(true);
    expect(matchesHook(effective(guidance), { event: 'step.before', agentRole: 'subagent', executorId: 'native' })).toBe(false);
    expect(matchesHook(effective(observation), { event: 'tool.after', status: 'error' })).toBe(true);
    expect(matchesHook(effective(observation), { event: 'tool.after', status: 'success' })).toBe(false);
    expect(examples[2]!.legacy).toEqual([{
      event: 'Notification', matcher: '^task\\.completed$', command: 'node .kiki/hooks/task-event.mjs', timeout: 5,
    }]);
    expect(HooksConfigSchema.safeParse({ ...examples[0], rules: [{ ...guidance, action: { type: 'command', command: 'check' } }] }).success).toBe(false);
    expect(HooksConfigSchema.safeParse({ ...examples[0], rules: [{ ...guidance, event: 'prompt.submit' }] }).success).toBe(false);
    expect(HooksConfigSchema.safeParse({ ...examples[0], rules: [{ ...guidance, event: 'tool.before', cadence: undefined }] }).success).toBe(false);
  });

  it('runs the bundled legacy script with its local positive and negative fixtures', () => {
    const script = [...HOOKS_REFERENCE.matchAll(/```js\n([\s\S]*?)```/g)][0]![1]!;
    const fixture = JSON.parse([...HOOKS_REFERENCE.matchAll(/```json\n([\s\S]*?)```/g)][0]![1]!);
    const run = (input: unknown) => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
    });
    expect(JSON.parse(run(fixture))).toEqual({ message: '已收到任务完成事件。' });
    expect(run({ ...fixture, hook_event_name: 'SessionStart' })).toBe('');
  });

  it('ships loadable inherit and model/tools-only profile examples', () => {
    const content = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')?.content ?? '';
    const examples = [...content.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match, index) =>
      parseAgentFileText({ path: `/examples/profile-${index}.md`, source: 'user', text: match[1]! }),
    );
    const inherited = examples.find((example) => example.systemPromptMode === 'inherit');
    expect(inherited).toBeDefined();
    expect(inherited?.prompt).toBe('');
    expect(inherited?.promptOverrides?.fields).toEqual({
      'delegation.sub.notice': 'Return one compact receipt: result, evidence, open risks.',
    });
    const modelOnly = examples.find((example) => example.prompt === '${base_prompt}');
    expect(modelOnly).toBeDefined();
    expect(modelOnly?.modelAlias).toBe('your-configured-model');
    expect(modelOnly?.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(modelOnly?.promptOverrides).toBeUndefined();
    expect(content).toContain('do not invent a prompt-field change just to pass validation');
    expect(content).toContain('For an existing self-contained subagent, retain its prompt body');
    expect(content).not.toContain("To change a built-in role's model, tools, or a few prompt fields, use `system_prompt_mode: inherit` with an empty body");
    const invalid = '---\nname: agent\ndescription: Model-only override\nmodel_alias: your-configured-model\nsystem_prompt_mode: inherit\n---\n';
    expect(() => parseAgentFileText({ path: '/examples/invalid.md', source: 'user', text: invalid }))
      .toThrow('"prompt_overrides"');
  });

  it('teaches literal hard model rules and separately named soft preferences', () => {
    const content = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')?.content ?? '';
    for (const needle of [
      '| `allowed_models` / `deny_models` | **Hard**',
      '| `allowed_efforts` | **Hard**',
      '| `preferred_models` / `discouraged_models` | **Soft**',
      '| `preferred_efforts` | **Soft**',
      'model_not_preferred',
      'model_discouraged',
      'effort_not_preferred',
      'profile, caller lease, `spawn_constraints`, and matching `model_profiles` entries',
      'Allowsets intersect; denials accumulate',
      'profile.constraint_violation',
      'explicit pins, manual selections, and resume cannot bypass hard rules',
      'including when a lease replaces their defaults',
      'There is no legacy-soft mode',
    ]) {
      expect(content).toContain(needle);
    }
    for (const stale of [
      'Advisory recommendations matched by canonical identity',
      'Effort pin and its recommended set',
      'Advisory limits for this role',
      '`allowed_models` only recommends',
    ]) {
      expect(content).not.toContain(stale);
    }
  });

  it('separates preset permissions, recommendations, and explicit file definitions', () => {
    const content = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')!.content;
    for (const needle of [
      'Soft preset-role recommendations',
      'Does not select a default or grant access',
      'allowed `[]` permits no presets, not a full leaf',
      '`false` makes a full leaf: no new preset or Markdown-file children',
      'Existing children can still resume',
      'it does not register or replace a catalog preset',
      'caller preset allow/deny lists and same-name leases do not apply',
      "Do not copy the caller's preset selection list",
      'Structured updates preserve omitted fields; `null` deletes a declaration',
    ]) expect(content).toContain(needle);
    const examples = [...content.matchAll(/```markdown\n([\s\S]*?)```/g)].map((match, index) =>
      parseAgentFileText({ path: `/examples/profile-${index}.md`, source: 'user', text: match[1]! }),
    );
    expect(examples.find((profile) => profile.name === 'implementer')).toMatchObject({ preferredSubagents: ['explore'] });
    expect(examples.find((profile) => profile.name === 'implementer')?.allowedSubagents).toBeUndefined();
    expect(examples.find((profile) => profile.name === 'reviewer')).toMatchObject({ canSpawnSubagents: false });
  });

  it('defaults profile authoring to soft preferences and asks consent for hard rules', () => {
    const content = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')?.content ?? '';
    expect(content).toContain('Users usually need soft preferences, especially for main-agent profiles');
    expect(content).toContain('Use hard fields only when the user explicitly requests enforcement');
    expect(content).toContain('explain the reason and consequences and obtain the user\'s consent before adding it');
    expect(content).toContain('never silently write a hard constraint');
    expect(content).toContain('preferred_models: [fast-model]');
    expect(content).toContain('To use a configured default model instead');
    expect(content).toContain('optionally set an effort and preference list');
    expect(content).toContain('preferred_models: [your-configured-model]');
    expect(content).not.toContain('allowed_models: [your-configured-model]');
    expect(content).toContain('Lists never select a model');
    expect(content).not.toContain('An `allowed_models` list without `model_alias` loads with a warning');
  });

  it('grounds executor configuration and delegation notices in their execution paths', () => {
    const content = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile')?.content ?? '';
    expect(content).toContain('External IDs are built in or configured under `[agent_executors.<id>]` in `config.toml`');
    expect(content).not.toContain('agent-executors.toml');
    expect(content).toContain('`allow_kiki_subagents: true` enables Kiki delegation over local stdio MCP');
    expect(content).toContain('For native execution, `auto` (default)');
    expect(content).toContain('unless `[agents.delegation] sub = false` / `independent = false`');
    expect(content).toContain('External prompt composition uses `executor_prompt`');
    expect(content).toContain('its default `include: []` adds no delegation notice automatically');
  });

  it('keeps kiki-appearance narrow and grounded in the pack contract', () => {
    const appearance = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-appearance');
    expect(appearance?.metadata.isSubSkill).not.toBe(true);
    expect(appearance?.description).toContain('appearance pack');
    expect(appearance?.description).toContain('Do not use merely to switch light/dark');
    for (const needle of ['"kind": "kiki-appearance-pack"', '4.5:1', 'surfaceOpacity', 'Custom CSS', 'poster']) {
      expect(appearance?.content).toContain(needle);
    }
  });

  it('provides detailed built-in tool workflows on demand without triggering for ordinary calls', () => {
    const workflows = BUILTIN_SKILLS.find((skill) => skill.name === 'tool-workflows');
    expect(workflows?.description).toContain('when a tool\'s compact description is insufficient');
    expect(workflows?.description).toContain('Do not invoke for a routine single tool call');
    expect(workflows?.content).toContain('## File inspection and editing');
    expect(workflows?.content).toContain('## Shell and background work');
    expect(workflows?.content).toContain('## Plan, goal, and schedule');
  });

  it('embeds both complete example files for installed skill invocation', () => {
    const profile = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-profile');
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops');
    for (const { fileName, text } of EXAMPLE_AGENT_PROFILE_TEMPLATES) {
      expect(profile?.content).toContain(`### ${fileName}\n\n\`\`\`markdown\n${text}\`\`\``);
    }
    expect(profile?.content).toContain('Both templates set `model_alias: inherit`');
    expect(profile?.content).toContain('leave `thinking_effort` unset');
    expect(ops?.content).toContain('Ask whether to create `implementer`');
    expect(ops?.content).toContain('ask separately about `reviewer`');
    expect(ops?.content).toContain('Copy the template with its `model_alias: inherit` frontmatter unchanged');
  });

  it('keeps the primary kiki-ops triggers visible in the rendered model listing', () => {
    const catalog = new InMemorySkillCatalog();
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops');
    expect(ops).toBeDefined();
    catalog.registerBuiltinSkill(ops!);
    const listing = catalog.getModelSkillListing().toLowerCase();
    for (const trigger of KIKI_OPS_TRIGGERS) {
      expect(listing).toContain(trigger);
    }
  });

  it('guides first-run web search without a credential gate or silent fallback', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops')!.content;
    expect(ops).toContain('keyless general-web `duckduckgo.search`');
    expect(ops).toContain('no registration, API key or lane selection is needed');
    expect(ops).toContain('check it directly when requested instead of asking for a key');
    expect(ops).toContain('failures never silently switch providers');
    expect(ops).not.toContain('General web search needs a provider lane, its credential');
  });

  it('routes request-limit operations through installed docs and keeps reload timing specific', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops')!;
    expect(ops.path).toBe('builtin://kiki-ops');
    expect(ops.content).toContain('Read the installed `configuration/config-files.md`');
    expect(ops.content).toContain('read `guides/settings.md`');
    for (const code of ['request.limit_rejected', 'request.queue_full', 'request.queue_timeout', 'provider.rate_limit']) {
      expect(ops.content).toContain(code);
    }
    expect(ops.content).toContain('exact canonical `[models]` keys');
    expect(ops.content).toContain('not independent CLI processes');
    expect(ops.content).toContain('External executors are unmanaged');
    expect(ops.content).toContain('Rule edits automatically re-evaluate waiters and leave active streams running');
    expect(ops.content).toContain('`identity` needs a process restart');
    expect(ops.content).toContain('not a required step for every edit');
    expect(ops.content).toContain('History opens by default');
    expect(ops.content).toContain('expand Request details');
    expect(ops.content).toContain('Usage → Live → Concurrency limits');
    expect(ops.content).toContain('legacy `?panel=limits` links focus the rules on Live');
    expect(ops.content).not.toContain('Usage → Limits');
    expect(ops.content).not.toContain('Apply: `/reload` in the TUI for `config.toml`');
  });

  it('routes memory and session controls without activating unused prompts or discarding preview state', () => {
    const ops = BUILTIN_SKILLS.find((skill) => skill.name === 'kiki-ops')!.content;
    for (const contract of [
      'Read `configuration/config-files.md` → Continuity reminder settings',
      'Read `guides/settings.md` → Session controls',
      'For explanation-only questions, use documented defaults without reading private configuration',
      'resolve the connected server host and actual `KIKI_HOME`',
      '`false` disables only that periodic reminder',
      'not standing-instruction or pre-compaction checks, memory tools, approvals, or TodoList notes',
      'Header ⋯ → Effective prompts',
      'a displayed composition is not proof it was sent',
      'Check all branches is explicit and does not activate other identities',
      'Standard / Exit cockpit restores preview content, tabs, draft and width',
      'exiting leaves the standard rail open',
      'Do not suggest clearing preview state',
    ]) expect(ops).toContain(contract);
  });

  it.each([
    ['en', 'opens **History** by default', 'Live → Concurrency limits', 'Request details'],
    ['zh', '默认打开「历史」', '实时 → 并发限制', '请求详情'],
  ])('keeps the %s Usage guide on the history/live/external-sync sections and legacy limits route', (locale, defaultTab, rulePath, details) => {
    const text = readFileSync(new URL(`../../../../../docs/${locale}/guides/settings.md`, import.meta.url), 'utf8');
    const usage = text.split('## Usage\n')[1]!.split('\n## ')[0]!;
    expect(usage.match(/^- \*\*/gm)).toHaveLength(3);
    expect(usage).toContain(defaultTab);
    expect(usage).toContain(details);
    expect(usage).toContain('/usage?panel=limits');
    expect(text).toContain(rulePath);
  });

  it('keeps bilingual request-governance examples valid and equivalent to the runtime schema', () => {
    const configurations = ['en', 'zh'].map((locale) => {
      const text = readFileSync(new URL(`../../../../../docs/${locale}/configuration/config-files.md`, import.meta.url), 'utf8');
      const section = text.split('## `[request_governance]`')[1]!.split('\n## ')[0]!;
      const examples = [...section.matchAll(/```toml\n([\s\S]*?)```/g)].map((match) => match[1]!);
      expect(examples).toHaveLength(2);
      return RequestGovernanceConfigSchema.parse(requestGovernanceFromToml(parseToml(examples.join('\n'))['request_governance']));
    });
    expect(configurations[0]).toEqual(configurations[1]);
    expect(configurations[0]).toMatchObject({
      schemaVersion: 1, maxWaitMs: 300000, maxQueueSize: 1024,
      rules: [
        { id: 'shared-provider', scope: 'global', providers: ['example-provider'], maxConcurrent: 2, overflow: 'queue', enabled: true },
        { id: 'session-model-children', scope: 'each_session', models: ['example-model'], subagentsOnly: true, maxConcurrent: 1, maxWaitMs: 60000 },
      ],
    });
  });

  it.each(['en', 'zh'])('loads the %s continuity examples through the real TOML adapter and round-trips the memory switch', async (locale) => {
    const registry = new ConfigRegistry();
    try {
      const text = readFileSync(new URL(`../../../../../docs/${locale}/configuration/config-files.md`, import.meta.url), 'utf8');
      const examples = [...text.matchAll(/```toml\n(\[loop_control\.continuity_cadence\][\s\S]*?)```/g)];
      expect(examples).toHaveLength(2);
      const values = examples.map((match) => LoopControlSchema.parse(transformTomlData(parseToml(match[1]!), registry)[LOOP_CONTROL_SECTION]));
      expect(values[0]?.continuityCadence).toEqual({ ageHumanTurns: 6, cooldownHumanTurns: 8, longTaskSteps: 24 });
      expect(values[1]?.continuityCadence).toEqual({ memoryMaintenance: false });
      const raw: Record<string, unknown> = {};
      applySectionToToml(raw, LOOP_CONTROL_SECTION, values[1], registry);
      expect(raw).toEqual({ loop_control: { continuity_cadence: { memory_maintenance: false } } });
      expect(LoopControlSchema.parse(transformTomlData(raw, registry)[LOOP_CONTROL_SECTION])).toEqual(values[1]);
    } finally {
      await registry.dispose();
    }
  });

  it('offers every builtin skill when the section is unset', async () => {
    const names = await loadNames();
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('offers every builtin skill when explicitly enabled', async () => {
    const names = await loadNames(true);
    expect(names).toEqual(BUILTIN_SKILLS.map((s) => s.name));
  });

  it('drops product-documentation skills when explicitly disabled', async () => {
    const names = await loadNames(false);
    expect(names).toEqual(NEUTRAL_SKILLS);
    for (const name of PRODUCT_SKILLS) expect(names).not.toContain(name);
  });

  it('exposes the same filter the session-less listings compose with', () => {
    expect(visibleBuiltinSkills(true).map((s) => s.name)).toEqual(
      BUILTIN_SKILLS.map((s) => s.name),
    );
    expect(visibleBuiltinSkills(false).map((s) => s.name)).toEqual(NEUTRAL_SKILLS);
  });

  it('signals a change when the switch is toggled', async () => {
    const config = new StubConfigService({ [BUILTIN_PRODUCT_SKILLS_SECTION]: true });
    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    ix.set(IFlagService, stubFlag(true));
    const source = ix.createInstance(BuiltinSkillSource);

    let fired = 0;
    source.onDidChange?.(() => {
      fired += 1;
    });

    await config.replace(BUILTIN_PRODUCT_SKILLS_SECTION, false);
    expect(fired).toBe(1);
    expect((await source.load()).skills.map((s) => s.name)).toEqual(NEUTRAL_SKILLS);

    await config.replace('unrelatedSection', 'x');
    expect(fired).toBe(1);
  });

  it('waits for config readiness before reading the switch', async () => {
    let release = (): void => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loaded = false;
    const config = {
      _serviceBrand: undefined,
      ready,
      get: () => (loaded ? false : undefined),
      onDidSectionChange: () => ({ dispose: () => {} }),
    } as unknown as IConfigService;

    const ix = new TestInstantiationService();
    ix.set(IConfigService, config);
    ix.set(IFlagService, stubFlag(true));
    const source = ix.createInstance(BuiltinSkillSource);

    const loading = source.load();
    loaded = true;
    release();

    const names = (await loading).skills.map((s) => s.name);
    expect(names).toEqual(NEUTRAL_SKILLS);
  });
});
