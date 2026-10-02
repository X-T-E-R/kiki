import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { parsePersonaFileText } from '@kiki/agent-profiles';

import { HooksConfigSchema, HooksV2ConfigSchema, hooksFromToml } from '#/features/externalHooks/configSection';
import { matchesHook, type EffectiveHookRule } from '#/features/externalHooks/internal/rules';
import PERSONA_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-persona/references/authoring.md?raw';
import HOOKS_REFERENCE from '../../../src/app/skillCatalog/builtin/kiki-hooks/references/authoring.md?raw';

import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { BUILTIN_SKILLS, visibleBuiltinSkills } from '#/app/skillCatalog/builtin/builtin';
import { EXAMPLE_AGENT_PROFILE_TEMPLATES } from '#/app/shippedAgentProfiles/examples/exampleAgentProfiles';
import { BuiltinSkillSource } from '#/app/skillCatalog/builtinSkillSource';
import { BUILTIN_PRODUCT_SKILLS_SECTION } from '#/app/skillCatalog/configSection';
import { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';

import { stubFlag } from '../flag/stubs';
import { StubConfigService } from '../../kosong/stubs';

const PRODUCT_SKILLS = ['kiki-ops', 'kiki-profile', 'kiki-persona', 'kiki-hooks', 'kiki-appearance', 'kiki-as-subagent', 'tool-workflows'];
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
    const description = ops?.description.toLowerCase() ?? '';
    for (const trigger of KIKI_OPS_TRIGGERS) {
      expect(description).toContain(trigger);
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
    for (const trigger of KIKI_OPS_TRIGGERS.slice(0, 10)) {
      expect(listing).toContain(trigger);
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
