import { describe, expect, it } from 'vitest';

import { AgentFileParseError, parseAgentFileText } from '#/agentFile';
import type { AgentFileDefinition, AgentFileDiscoveryResult } from '#/agentFileTypes';
import { agentProfileFromFile, profilesFromDiscovery } from '#/agentProfileFromFile';
import type { SystemPromptRenderResult } from '#/agentProfile';

const FULL_FILE = `---
name: code-reviewer
description: 严格的代码审查 agent
whenToUse: 代码评审、PR 检查
override: true
tools:
  - Read
  - Grep
  - mcp__github__*
disallowedTools:
  - Bash
subagents:
  - explore
  - plan
---

你是严格的代码审查者。
`;

function parse(text: string): AgentFileDefinition {
  return parseAgentFileText({ path: '/tmp/agents/reviewer.md', source: 'project', text });
}

describe('parseAgentFileText', () => {
  it('parses a full agent file', () => {
    const def = parse(FULL_FILE);

    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe('严格的代码审查 agent');
    expect(def.whenToUse).toBe('代码评审、PR 检查');
    expect(def.override).toBe(true);
    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
    expect(def.subagents).toEqual(['explore', 'plan']);
    expect(def.prompt).toBe('你是严格的代码审查者。');
    expect(def.source).toBe('project');
  });

  it('leaves optional fields undefined when omitted', () => {
    const def = parse('---\nname: solo\ndescription: d\n---\n\nbody\n');

    expect(def.override).toBe(false);
    expect(def.serviceTier).toBeUndefined();
    expect(def.requestParams).toBeUndefined();
    expect(def.modelProfiles).toBeUndefined();
    expect(def.allowedModels).toBeUndefined();
    expect(def.denyModels).toBeUndefined();
    expect(def.allowedEfforts).toBeUndefined();
    expect(def.tools).toBeUndefined();
    expect(def.disallowedTools).toBeUndefined();
    expect(def.subagents).toBeUndefined();
    expect(def.whenToUse).toBeUndefined();
    expect(def.prompt).toBe('body');
    expect(def.main).toBeUndefined();
    expect(def.delegationNotice).toBeUndefined();
    expect(def.executor).toBeUndefined();
    expect(def.executorOptions).toBeUndefined();
  });

  it('parses executor and scalar executor options', () => {
    const def = parse(`---
name: solo
description: d
executor: grok-acp
executor_options:
  mode: default
  retries: 2
  enabled: true
---

body
`);

    expect(def.executor).toBe('grok-acp');
    expect(def.executorOptions).toEqual({
      mode: 'default',
      retries: 2,
      enabled: true,
    });
  });

  it('rejects executor_options without an executor', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nexecutor_options:\n  mode: default\n---\n\nbody\n'),
    ).toThrow(/"executor".*required/);
  });

  it('rejects external executors on main profiles', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nmain: true\nexecutor: grok-acp\n---\n\nbody\n'),
    ).toThrow(/unsupported for main/);
  });

  it('preserves explicit main: false separately from omission', () => {
    expect(parse('---\nname: agent\ndescription: d\nmain: false\n---\nbody').main).toBe(false);
  });

  it('parses main: true as a curation flag', () => {
    const def = parse('---\nname: solo\ndescription: d\nmain: true\n---\n\nbody\n');
    expect(def.main).toBe(true);
  });

  it('parses delegation_notice off', () => {
    const def = parse('---\nname: solo\ndescription: d\ndelegation_notice: off\n---\n\nbody\n');
    expect(def.delegationNotice).toBe('off');
  });

  it('rejects an unsupported delegation_notice', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\ndelegation_notice: always\n---\n\nbody\n'),
    ).toThrow(/"delegation_notice"/);
  });

  it('parses exact model, effort, and service tier fields', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nmodel_alias: fast-model\nthinking_effort: low\nservice_tier: priority\n---\n\nbody\n',
    );
    expect(def).toMatchObject({
      modelAlias: 'fast-model',
      thinkingEffort: 'low',
      serviceTier: 'priority',
    });
  });

  it('parses recommended_models as advisory entries without consuming model_alias', () => {
    const def = parse(`---
name: solo
description: d
model_alias: gpt-5.6-sol
thinking_effort: high
recommended_models:
  - alias: axon-message/grok-4.6
    when: Scope and acceptance checks are already named and a fast decisive pass beats waiting.
    thinking_effort: high
  - alias: axon-message/deepseek-v4-pro-0813
    when: Ordinary coding where DeepSeek Pro can finish the acceptance checks.
---

body
`);

    expect(def.modelAlias).toBe('gpt-5.6-sol');
    expect(def.thinkingEffort).toBe('high');
    expect(def.modelProfiles).toEqual([
      {
        alias: 'axon-message/grok-4.6',
        when: 'Scope and acceptance checks are already named and a fast decisive pass beats waiting.',
        thinkingEffort: 'high',
      },
      {
        alias: 'axon-message/deepseek-v4-pro-0813',
        when: 'Ordinary coding where DeepSeek Pro can finish the acceptance checks.',
      },
    ]);
  });

  it('keeps two recommended_models entries that share an alias with different thinking_effort', () => {
    const def = parse(`---
name: solo
description: d
recommended_models:
  - alias: shared-model
    when: Fast pass.
    thinking_effort: low
  - alias: shared-model
    when: Careful pass.
    thinking_effort: high
---

body
`);

    expect(def.modelProfiles).toEqual([
      { alias: 'shared-model', when: 'Fast pass.', thinkingEffort: 'low' },
      { alias: 'shared-model', when: 'Careful pass.', thinkingEffort: 'high' },
    ]);
  });

  it('accepts alias-only candidates with either model-profile spelling', () => {
    for (const field of ['recommended_models', 'model_profiles']) {
      const definition = parse(`---\nname: solo\ndescription: d\n${field}:\n  - alias: other-model\n---\n\nbody\n`);
      expect(definition.modelProfiles).toEqual([{ alias: 'other-model' }]);
    }
  });

  it('parses independent profile budgets and per-model request overrides', () => {
    const definition = parse(`---
name: solo
description: d
context_budget: 64000
max_completion_tokens: 8000
model_profiles:
  - alias: other-model
    context_budget: 32000
    max_completion_tokens: 4000
    service_tier: flex
    request_params:
      temperature: 0.4
      top_p: 0.8
---
body
`);
    expect(definition).toMatchObject({ contextBudget: 64000, maxCompletionTokens: 8000 });
    expect(definition.modelProfiles?.[0]).toMatchObject({
      alias: 'other-model', contextBudget: 32000, maxCompletionTokens: 4000,
      serviceTier: 'flex', requestParams: { temperature: 0.4, top_p: 0.8 },
    });
    expect(() => parse('---\nname: solo\ndescription: d\ncontext_budget: 0\n---\nbody')).toThrow(/positive integer/);
  });

  it('rejects a recommended_models entry with an unknown key', () => {
    expect(() =>
      parse(
        '---\nname: solo\ndescription: d\nrecommended_models:\n  - alias: other-model\n    when: now\n    rank: 1\n---\n\nbody\n',
      ),
    ).toThrow(/unknown key "rank"/);
  });

  it.each([
    ['bare string', 'recommended_models: other-model'],
    ['scalar', 'recommended_models: 42'],
    ['mapping', 'recommended_models:\n  alias: other-model\n  when: now'],
  ])('rejects recommended_models when it is a %s rather than a list', (_label, field) => {
    expect(() => parse(`---\nname: solo\ndescription: d\n${field}\n---\n\nbody\n`)).toThrow(
      /"recommended_models"/,
    );
  });

  it('parses model_profiles with prompt delta and allowed_efforts', () => {
    const def = parse(`---
name: solo
description: d
model_profiles:
  - alias: k3-256k
    when: System-level reasoning.
    thinking_effort: max
    allowed_efforts: [max]
    prompt_mode: prepend
    prompt: |
      Reason at the system level.
---

body
`);

    expect(def.modelProfiles).toEqual([
      {
        alias: 'k3-256k',
        when: 'System-level reasoning.',
        thinkingEffort: 'max',
        allowedEfforts: ['max'],
        promptMode: 'prepend',
        prompt: 'Reason at the system level.',
      },
    ]);
  });

  it('accepts wrap prompt with parent_prompt exactly once', () => {
    const def = parse(`---
name: solo
description: d
model_profiles:
  - alias: k3-256k
    when: wrap it
    prompt_mode: wrap
    prompt: |
      BEFORE
      \${parent_prompt}
      AFTER
---

body
`);

    expect(def.modelProfiles?.[0]).toMatchObject({
      promptMode: 'wrap',
      prompt: 'BEFORE\n${parent_prompt}\nAFTER',
    });
  });

  it('rejects wrap prompt without a parent token', () => {
    expect(() =>
      parse(`---
name: solo
description: d
model_profiles:
  - alias: k3-256k
    when: wrap it
    prompt_mode: wrap
    prompt: no parent
---

body
`),
    ).toThrow(/exactly once/);
  });

  it('warns once when only the deprecated recommended_models key is present', () => {
    const warnings: string[] = [];
    const def = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nrecommended_models:\n  - alias: other-model\n    when: now\n---\n\nbody\n',
      warn: (message) => warnings.push(message),
    });

    expect(def.modelProfiles).toEqual([{ alias: 'other-model', when: 'now' }]);
    expect(warnings).toEqual([
      expect.stringContaining('recommended_models" in /tmp/agents/reviewer.md is deprecated'),
    ]);
  });

  it('prefers model_profiles and warns when both keys are present', () => {
    const warnings: string[] = [];
    const def = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: `---
name: solo
description: d
model_profiles:
  - alias: new-model
    when: new
recommended_models:
  - alias: old-model
    when: old
---

body
`,
      warn: (message) => warnings.push(message),
    });

    expect(def.modelProfiles).toEqual([{ alias: 'new-model', when: 'new' }]);
    expect(warnings).toEqual([
      expect.stringContaining('using "model_profiles"'),
    ]);
  });

  it.each(['auto', 'default', 'flex', 'priority'] as const)(
    'accepts the %s service tier',
    (serviceTier) => {
      const def = parse(
        `---\nname: solo\ndescription: d\nservice_tier: ${serviceTier}\n---\n\nbody\n`,
      );
      expect(def.serviceTier).toBe(serviceTier);
    },
  );

  it('rejects unsupported or non-string service tiers', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nservice_tier: premium\n---\n\nbody\n'),
    ).toThrow(/"service_tier"/);
    expect(() =>
      parse('---\nname: solo\ndescription: d\nservice_tier: 42\n---\n\nbody\n'),
    ).toThrow(/"service_tier"/);
  });

  it.each([
    [
      'block',
      'request_params:\n  seed: 42\n  enabled: true\n  label: fast',
    ],
    [
      'inline',
      'request_params: { seed: 42, enabled: true, label: fast }',
    ],
  ])('parses a %s scalar request_params map', (_style, field) => {
    const def = parse(`---\nname: solo\ndescription: d\n${field}\n---\n\nbody\n`);

    expect(def.requestParams).toEqual({ seed: 42, enabled: true, label: 'fast' });
  });

  it('keeps __proto__ as data without polluting the request-params prototype', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\nrequest_params:\n  __proto__: polluted\n  seed: 42\n---\n\nbody\n',
    );

    expect(Object.hasOwn(def.requestParams!, '__proto__')).toBe(true);
    expect(def.requestParams?.['__proto__']).toBe('polluted');
    expect(Object.getPrototypeOf(def.requestParams)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it.each([
    'request_params:\n  nested:\n    value: true',
    'request_params:\n  values: [one, two]',
    'request_params: null',
  ])('rejects non-scalar request_params values: %s', (field) => {
    expect(() =>
      parse(`---\nname: solo\ndescription: d\n${field}\n---\n\nbody\n`),
    ).toThrow(AgentFileParseError);
  });

  it('warns and lets service_tier override request_params.service_tier', () => {
    const warnings: string[] = [];
    const def = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nservice_tier: priority\nrequest_params:\n  service_tier: flex\n  seed: 42\n---\n\nbody\n',
      warn: (message) => warnings.push(message),
    });

    expect(def.serviceTier).toBe('priority');
    expect(def.requestParams).toEqual({ seed: 42 });
    expect(warnings).toEqual([
      expect.stringContaining('service_tier" in /tmp/agents/reviewer.md overrides request_params.service_tier'),
    ]);
  });

  it('rejects the removed model_preference field outright', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nmodel_preference: primary\n---\n\nbody\n'),
    ).toThrow(/"model_preference".+has been removed/);
  });

  it('rejects missing frontmatter', () => {
    expect(() => parse('no frontmatter here')).toThrow(AgentFileParseError);
  });

  it('rejects non-mapping frontmatter', () => {
    expect(() => parse('---\n- just\n- a\n- list\n---\n\nbody\n')).toThrow(/mapping/);
  });

  it('rejects invalid yaml frontmatter', () => {
    expect(() => parse('---\nfoo: [unclosed\n---\n\nbody\n')).toThrow(AgentFileParseError);
  });

  it('derives the name from the file name when omitted', () => {
    const def = parse('---\ndescription: d\n---\n\nbody\n');

    expect(def.name).toBe('reviewer');
  });

  it('rejects when the name is neither provided nor derivable', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/"name"/);
  });

  it('rejects a derived name that is not kebab-case', () => {
    expect(() =>
      parseAgentFileText({
        path: '/tmp/agents/My Agent.md',
        source: 'project',
        text: '---\ndescription: d\n---\n\nbody\n',
      }),
    ).toThrow(/kebab-case/);
  });

  it('rejects a missing description', () => {
    expect(() => parse('---\nname: solo\n---\n\nbody\n')).toThrow(/"description"/);
  });

  it('rejects non kebab-case names', () => {
    expect(() => parse('---\nname: CodeReviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
    expect(() => parse('---\nname: code_reviewer\ndescription: d\n---\n\nbody\n')).toThrow(
      /kebab-case/,
    );
  });

  it('rejects unknown top-level frontmatter keys', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nmode: subagent\n---\n\nbody\n'),
    ).toThrow(/Unknown frontmatter field "mode"/);
  });

  it('rejects a non-boolean override field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\noverride: yes\n---\n\nbody\n')).toThrow(
      /"override"/,
    );
  });

  it('accepts a comma-separated tools string (Claude Code style)', () => {
    const def = parse(
      '---\nname: solo\ndescription: d\ntools: Read, Grep,mcp__github__*\ndisallowedTools: Bash\n---\n\nbody\n',
    );

    expect(def.tools).toEqual(['Read', 'Grep', 'mcp__github__*']);
    expect(def.disallowedTools).toEqual(['Bash']);
  });

  it('treats a lone "*" tools field as all tools', () => {
    const fromString = parse('---\nname: solo\ndescription: d\ntools: "*"\n---\n\nbody\n');
    const fromList = parse('---\nname: solo\ndescription: d\ntools:\n  - "*"\n---\n\nbody\n');

    expect(fromString.tools).toBeUndefined();
    expect(fromList.tools).toBeUndefined();
  });

  it('accepts a comma-separated subagents string', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: explore, plan\n---\n\nbody\n');

    expect(def.subagents).toEqual(['explore', 'plan']);
  });

  it('treats a lone "*" subagents field as all subagent types', () => {
    const def = parse('---\nname: solo\ndescription: d\nsubagents: "*"\n---\n\nbody\n');

    expect(def.subagents).toBeUndefined();
  });

  it('rejects a non-string, non-list subagents field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\nsubagents: 42\n---\n\nbody\n')).toThrow(
      /"subagents"/,
    );
  });

  it('rejects a non-string, non-list tools field', () => {
    expect(() => parse('---\nname: solo\ndescription: d\ntools: 42\n---\n\nbody\n')).toThrow(
      /"tools"/,
    );
  });

  it('parses allowed_models and deny_models as a YAML list or comma-separated string', () => {
    const fromList = parse(`---
name: solo
description: d
allowed_models:
  - fast-model
  - k3-review
deny_models:
  - heavy-model
---

body
`);
    const fromString = parse(
      '---\nname: solo\ndescription: d\nallowed_models: fast-model, k3-review\ndeny_models: heavy-model\n---\n\nbody\n',
    );

    expect(fromList.allowedModels).toEqual(['fast-model', 'k3-review']);
    expect(fromList.denyModels).toEqual(['heavy-model']);
    expect(fromString.allowedModels).toEqual(['fast-model', 'k3-review']);
    expect(fromString.denyModels).toEqual(['heavy-model']);
  });

  it('warns when model_alias is excluded by the profile\'s own constraints and still loads', () => {
    const denyWarnings: string[] = [];
    const denied = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nmodel_alias: heavy-model\ndeny_models: [heavy-model]\n---\n\nbody\n',
      warn: (message) => denyWarnings.push(message),
    });
    expect(denied.modelAlias).toBe('heavy-model');
    expect(denied.denyModels).toEqual(['heavy-model']);
    expect(denyWarnings).toEqual([
      expect.stringContaining('model_alias" in /tmp/agents/reviewer.md is listed in deny_models'),
    ]);

    const allowWarnings: string[] = [];
    const excluded = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nmodel_alias: k3-review\nallowed_models: [fast-model]\n---\n\nbody\n',
      warn: (message) => allowWarnings.push(message),
    });
    expect(excluded.modelAlias).toBe('k3-review');
    expect(excluded.allowedModels).toEqual(['fast-model']);
    expect(allowWarnings).toEqual([
      expect.stringContaining('model_alias" in /tmp/agents/reviewer.md is not in allowed_models'),
    ]);
  });

  it('does not warn when model_alias and a constraint entry are equivalent spellings', () => {
    const warnings: string[] = [];
    const parsed = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nmodel_alias: fast-model\nallowed_models: [vendor/fast-model]\n---\n\nbody\n',
      warn: (message) => warnings.push(message),
    });
    expect(parsed.modelAlias).toBe('fast-model');
    expect(warnings).toEqual([]);
  });

  it('warns when an allowlist is declared without model_alias', () => {
    const warnings: string[] = [];
    const parsed = parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\nallowed_models: [fast-model]\n---\n\nbody\n',
      warn: (message) => warnings.push(message),
    });
    expect(parsed.modelAlias).toBeUndefined();
    expect(parsed.allowedModels).toEqual(['fast-model']);
    expect(warnings).toEqual([
      expect.stringContaining('allowed_models" in /tmp/agents/reviewer.md is set without "model_alias"'),
    ]);
  });

  it('does not warn when only deny_models is declared without model_alias', () => {
    const warnings: string[] = [];
    parseAgentFileText({
      path: '/tmp/agents/reviewer.md',
      source: 'project',
      text: '---\nname: solo\ndescription: d\ndeny_models: [heavy-model]\n---\n\nbody\n',
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
  });

  it('rejects a non-string, non-list allowed_models field', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\nallowed_models: 42\n---\n\nbody\n'),
    ).toThrow(/"allowed_models"/);
  });

  it('rejects non-string tool entries', () => {
    expect(() =>
      parse('---\nname: solo\ndescription: d\ntools:\n  - 42\n---\n\nbody\n'),
    ).toThrow(/non-empty strings/);
  });

  it('rejects an empty prompt body', () => {
    expect(() => parse('---\nname: solo\ndescription: d\n---\n')).toThrow(/prompt body/);
  });

  it('parses a mixed subagents list into names plus leases', () => {
    const def = parse(`---
name: grok-play
description: d
spawn_constraints:
  allowed_models: [grok-4.6, grok-4.6-fast]
  allowed_efforts: [low, medium, high]
subagents:
  - explore
  - name: worker-lite
    model_alias: grok-4.6-fast
    thinking_effort: high
    allowed_models: [grok-4.6, grok-4.6-fast]
    tools: [Bash, Read, Grep, Glob]
    prompt_mode: append
    prompt: ignore worktrees
  - name: reviewer
    deny_models: [gpt-5.6-sol]
    whenToUse: only review kiki diffs
---

body
`);
    expect(def.subagents).toEqual(['explore', 'worker-lite', 'reviewer']);
    expect(def.spawnConstraints).toEqual({
      allowedModels: ['grok-4.6', 'grok-4.6-fast'],
      allowedEfforts: ['low', 'medium', 'high'],
    });
    expect(def.subagentLeases?.['worker-lite']).toMatchObject({
      name: 'worker-lite',
      modelAlias: 'grok-4.6-fast',
      thinkingEffort: 'high',
      allowedModels: ['grok-4.6', 'grok-4.6-fast'],
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      promptMode: 'append',
      prompt: 'ignore worktrees',
    });
    expect(def.subagentLeases?.['reviewer']).toMatchObject({
      name: 'reviewer',
      denyModels: ['gpt-5.6-sol'],
      whenToUse: 'only review kiki diffs',
    });
    expect(def.subagentLeases?.['explore']).toBeUndefined();
  });

  it('keeps a string-only subagents list without a lease table', () => {
    const def = parse(FULL_FILE);
    expect(def.subagents).toEqual(['explore', 'plan']);
    expect(def.subagentLeases).toBeUndefined();
    expect(def.spawnConstraints).toBeUndefined();
  });

  it('rejects duplicate subagent names', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - explore
  - name: explore
    model_alias: grok-4.6
---

body
`),
    ).toThrow(/more than once/);
  });

  it('rejects a dotted lease name', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - name: explore.flash
    model_alias: grok-4.6
---

body
`),
    ).toThrow(/kebab-case profile name, not a route id/);
  });

  it('rejects prompt_mode replace on a lease', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - name: worker-lite
    prompt_mode: replace
    prompt: no
---

body
`),
    ).toThrow(/cannot be "replace"/);
  });

  it('rejects nested mappings inside a lease subagents overlay', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - name: worker-lite
    subagents:
      - name: explore
        model_alias: grok-4.6
---

body
`),
    ).toThrow(/list of non-empty strings/);
  });

  it('rejects spawn_constraints nested on a lease entry', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - name: worker-lite
    spawn_constraints:
      allowed_models: [grok-4.6]
---

body
`),
    ).toThrow(/cannot be overlaid/);
  });

  it('rejects an unknown lease key', () => {
    expect(() =>
      parse(`---
name: solo
description: d
subagents:
  - name: worker-lite
    rank: 1
---

body
`),
    ).toThrow(/unknown key "rank"/);
  });

  it('coerces an empty allowed_models list to unrestricted', () => {
    const def = parse('---\nname: solo\ndescription: d\nallowed_models: []\n---\n\nbody\n');
    expect(def.allowedModels).toBeUndefined();
  });
});

describe('agentProfileFromFile', () => {
  const base: AgentFileDefinition = {
    name: 'reviewer',
    definitionId: '/tmp/agents/reviewer.md',
    contributionRoot: '/tmp/agents',
    private: false,
    description: 'd',
    whenToUse: 'reviews',
    override: false,
    prompt: 'PROMPT_BODY',
    path: '/tmp/agents/reviewer.md',
    source: 'user',
  };
  const basePrompt = (): SystemPromptRenderResult => ({
    text: 'BASE_PROMPT',
    environment: {
      cwd: '',
      date: { disclosed: false },
    },
  });

  it('projects explicit executor binding normalization from the validation port', () => {
    const definition = {
      ...base,
      executor: 'grok-acp',
      modelAlias: 'grok-4.6',
      thinkingEffort: 'xhigh',
    };
    const discovery: AgentFileDiscoveryResult = {
      agents: [definition],
      routes: [],
      skipped: [],
      scannedRoots: ['/tmp/agents'],
      scopedBindings: new Map(),
      sourceDefinitions: new Map([[definition.definitionId, definition]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };

    const contribution = profilesFromDiscovery(discovery, basePrompt, undefined, {
      allowExternal: true,
      validateExecutor: (_id, _options, binding) => ({
        ok: true,
        binding: {
          modelAlias: `${binding.modelAlias}-validated`,
          thinkingEffort: binding.thinkingEffort,
        },
      }),
    });

    expect(contribution.profiles[0]).toMatchObject({
      modelAlias: 'grok-4.6-validated',
      thinkingEffort: 'xhigh',
    });
    expect(contribution.sourceDefinitions?.get(definition.definitionId)).toMatchObject({
      modelAlias: 'grok-4.6-validated',
      thinkingEffort: 'xhigh',
    });
  });

  it('omits an external profile when the validation port returns a diagnostic', () => {
    const definition = {
      ...base,
      executor: 'missing-executor',
      modelAlias: 'external-model',
    };
    const discovery: AgentFileDiscoveryResult = {
      agents: [definition],
      routes: [],
      skipped: [],
      scannedRoots: ['/tmp/agents'],
      scopedBindings: new Map(),
      sourceDefinitions: new Map([[definition.definitionId, definition]]),
      dependencyIndex: new Map(),
      diagnostics: [],
    };

    const contribution = profilesFromDiscovery(discovery, basePrompt, undefined, {
      allowExternal: true,
      validateExecutor: () => ({ ok: false, diagnostic: 'provider missing' }),
    });

    expect(contribution.profiles).toEqual([]);
    expect(contribution.sourceDefinitions?.size).toBe(0);
    expect(contribution.skipped).toEqual([
      expect.objectContaining({ reason: 'provider missing' }),
    ]);
    expect(contribution.diagnostics).toEqual([
      expect.objectContaining({ message: 'provider missing' }),
    ]);
    const legacy = profilesFromDiscovery(discovery, basePrompt, undefined, {
      allowExternal: true,
      validateExecutor: () => 'legacy provider missing',
    });
    expect(legacy.profiles).toEqual([]);
    expect(legacy.skipped).toEqual([
      expect.objectContaining({ reason: 'legacy provider missing' }),
    ]);
  });

  it('returns a plain body verbatim and injects no unreferenced context', () => {
    const profile = agentProfileFromFile(base, basePrompt);
    const prompt = profile.systemPrompt({
      agentsMd: 'AGENTS_MD_CONTENT',
      skills: 'SKILLS_LISTING',
      pluginSections: 'PLUGIN_INSTRUCTIONS',
    });

    expect(prompt).toBe('PROMPT_BODY');
    expect(profile.tools).toBeUndefined();
    expect(profile.sourcePath).toBe('/tmp/agents/reviewer.md');
    expect(profile.whenToUse).toBe('reviews');
    expect(profile.override).toBe(false);
  });

  it('substitutes context variables in the body', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'cwd=${cwd} agents=${agents_md} skills=${skills}' },
      basePrompt,
    );
    const prompt = profile.systemPrompt({
      cwd: '/work',
      agentsMd: 'AGENTS_MD_CONTENT',
      skills: 'SKILLS_LISTING',
    });

    expect(prompt).toBe('cwd=/work agents=AGENTS_MD_CONTENT skills=SKILLS_LISTING');
  });

  it('empties ${skills} when the file allowlist drops the Skill tool', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', tools: ['Read'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('empties ${skills} when Skill is in disallowedTools', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'skills=${skills}', disallowedTools: ['Skill'] },
      basePrompt,
    );

    expect(profile.systemPrompt({ skills: 'SKILLS_LISTING' })).toBe('skills=');
  });

  it('embeds the effective default prompt via ${base_prompt}', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'extra instructions\n\n${base_prompt}' },
      basePrompt,
    );

    expect(profile.systemPrompt({})).toBe('extra instructions\n\nBASE_PROMPT');
  });

  it('embeds the effective default prompt via ${parent_prompt} and the builtin via ${builtin_prompt}', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'parent=${parent_prompt} builtin=${builtin_prompt}' },
      basePrompt,
      () => ({
        text: 'BUILTIN_PROMPT',
        environment: { cwd: '', date: { disclosed: false } },
      }),
    );

    expect(profile.systemPrompt({})).toBe('parent=BASE_PROMPT builtin=BUILTIN_PROMPT');
  });

  it('forwards the base prompt environment disclosure through renderSystemPrompt', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'extra instructions\n\n${base_prompt}' },
      (): SystemPromptRenderResult => ({
        text: 'BASE_PROMPT',
        environment: {
          cwd: '/work',
          date: {
            disclosed: true,
            value: { localDate: '2026-07-29', timeZone: 'Asia/Shanghai' },
          },
        },
      }),
    );

    const rendered = profile.renderSystemPrompt({ cwd: '/work' });
    expect(rendered.text).toBe('extra instructions\n\nBASE_PROMPT');
    expect(rendered.environment).toEqual({
      cwd: '/work',
      date: {
        disclosed: true,
        value: { localDate: '2026-07-29', timeZone: 'Asia/Shanghai' },
      },
    });
  });

  it('places plugin instructions where ${plugin_sections} is referenced', () => {
    const profile = agentProfileFromFile(
      { ...base, prompt: 'before\n${plugin_sections}after' },
      basePrompt,
    );

    const prompt = profile.systemPrompt({ pluginSections: 'PLUGIN_INSTRUCTIONS' });

    expect(prompt).toContain('before');
    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_INSTRUCTIONS');
    expect(prompt).toContain('after');
  });

  it('passes tools and disallowedTools through', () => {
    const profile = agentProfileFromFile(
      { ...base, tools: ['Read'], disallowedTools: ['Bash'] },
      basePrompt,
    );

    expect(profile.tools).toEqual(['Read']);
    expect(profile.disallowedTools).toEqual(['Bash']);
  });

  it('passes subagents through', () => {
    const profile = agentProfileFromFile({ ...base, subagents: ['explore'] }, basePrompt);

    expect(profile.subagents).toEqual(['explore']);
  });

  it('passes exact model, effort, service tier, and request params through', () => {
    const profile = agentProfileFromFile(
      {
        ...base,
        modelAlias: 'fast-model',
        thinkingEffort: 'low',
        serviceTier: 'priority',
        requestParams: { seed: 42, enabled: true },
      },
      basePrompt,
    );
    expect(profile).toMatchObject({
      modelAlias: 'fast-model',
      thinkingEffort: 'low',
      serviceTier: 'priority',
      requestParams: { seed: 42, enabled: true },
    });
  });

  it('passes model profiles through without injecting when into the prompt', () => {
    const modelProfiles = [
      { alias: 'other-model', when: 'When the task is already scoped.' },
    ];
    const profile = agentProfileFromFile(
      { ...base, modelProfiles, prompt: 'PROMPT_BODY' },
      basePrompt,
    );

    expect(profile.modelProfiles).toEqual(modelProfiles);
    expect(profile.systemPrompt({})).toBe('PROMPT_BODY');
    expect(profile.systemPrompt({})).not.toContain('already scoped');
  });

  it('passes allowed_models and deny_models through', () => {
    const profile = agentProfileFromFile(
      { ...base, allowedModels: ['fast-model'], denyModels: ['heavy-model'] },
      basePrompt,
    );

    expect(profile.allowedModels).toEqual(['fast-model']);
    expect(profile.denyModels).toEqual(['heavy-model']);
  });

  it('passes allowed_efforts through', () => {
    const profile = agentProfileFromFile(
      { ...base, allowedEfforts: ['max', 'high'] },
      basePrompt,
    );

    expect(profile.allowedEfforts).toEqual(['max', 'high']);
  });

  it('passes subagent leases and spawn_constraints through', () => {
    const profile = agentProfileFromFile(
      {
        ...base,
        subagents: ['explore', 'worker-lite'],
        subagentLeases: {
          'worker-lite': { name: 'worker-lite', modelAlias: 'grok-4.6-fast' },
        },
        spawnConstraints: { allowedModels: ['grok-4.6'] },
      },
      basePrompt,
    );

    expect(profile.subagents).toEqual(['explore', 'worker-lite']);
    expect(profile.subagentLeases?.['worker-lite']?.modelAlias).toBe('grok-4.6-fast');
    expect(profile.spawnConstraints).toEqual({ allowedModels: ['grok-4.6'] });
  });

  it('passes main through', () => {
    const profile = agentProfileFromFile({ ...base, main: true }, basePrompt);

    expect(profile.main).toBe(true);
  });

  it('passes delegation_notice through', () => {
    const profile = agentProfileFromFile(
      { ...base, delegationNotice: 'off' },
      basePrompt,
    );

    expect(profile.delegationNotice).toBe('off');
  });

  it('treats an explicit file as an override intent', () => {
    const profile = agentProfileFromFile({ ...base, source: 'explicit' }, basePrompt);

    expect(profile.override).toBe(true);
  });
});
