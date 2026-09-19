import { describe, expect, it } from 'vitest';
import { PromptConfigSchema, RESERVED_PROMPT_VARIABLES } from '#/promptConfig';
import { renderPrompt } from '#/renderPrompt';
import { applySystemPromptFields } from '#/systemPromptFields';
import SYSTEM_PROMPT_TEMPLATE from '../src/system.md?raw';

import {
  normalizeAgentProfile,
  type AgentProfileContext,
  type AgentProfileInput,
  type SystemPromptRenderResult,
} from '#/agentProfile';
import {
  _clearAgentProfileContributionsForTests,
  getAgentProfileContributions,
  registerAgentProfile,
} from '#/contribution';
import {
  DEFAULT_REPLY_STYLE_GUIDE,
  renderPromptTemplateResult,
  renderSystemPromptResult,
  systemPromptVars,
} from '#/profileShared';

type AssertFalse<T extends false> = T;

type RenderlessInputIsNotAssignable = AssertFalse<
  [{ name: string }] extends [AgentProfileInput] ? true : false
>;

describe('systemPromptVars', () => {
  it('builds the full variable table from the context', () => {
    const vars = systemPromptVars(
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'macOS',
        shellName: 'zsh',
        shellPath: '/bin/zsh',
        now: 'NOW',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    );

    expect(vars['role_additional']).toBe('');
    expect(vars['os']).toBe('macOS');
    expect(vars['windows_notes']).toBe('');
    expect(vars['shell']).toBe('zsh (`/bin/zsh`)');
    expect(vars['now']).toBe('NOW');
    expect(vars['cwd']).toBe('/work');
    expect(vars['cwd_listing']).toBe('LISTING');
    expect(vars['agents_md']).toBe('AGENTS');
    expect(vars['additional_dirs_info']).toBe('/extra');
    expect(vars['skills']).toBe('SKILLS');
    expect(vars['additional_dirs_section']).toContain('## Additional Directories');
    expect(vars['additional_dirs_section']).toContain('/extra');
    expect(vars['skills_section']).toContain('# Skills');
    expect(vars['skills_section']).toContain('SKILLS');
  });

  it('renders missing context fields as empty strings and defaults ${now}', () => {
    const vars = systemPromptVars({}, { skillActive: true });

    expect(vars['cwd']).toBe('');
    expect(vars['cwd_listing']).toBe('');
    expect(vars['shell']).toBe('');
    expect(vars['agents_md']).toBe('');
    expect(vars['additional_dirs_info']).toBe('');
    expect(vars['additional_dirs_section']).toBe('');
    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
    expect(vars['windows_notes']).toBe('');
    expect(vars['role_additional']).toBe('');
    expect(Number.isNaN(Date.parse(vars['now'] ?? ''))).toBe(false);
  });

  it('empties skills and the skills section when the Skill tool is off', () => {
    const vars = systemPromptVars({ skills: 'SKILLS' }, { skillActive: false });

    expect(vars['skills']).toBe('');
    expect(vars['skills_section']).toBe('');
  });

  it('lets a context skillActive override the profile default', () => {
    const vars = systemPromptVars({ skills: 'SKILLS', skillActive: true }, { skillActive: false });

    expect(vars['skills']).toBe('SKILLS');
  });

  it('composes Windows notes only on Windows', () => {
    expect(
      systemPromptVars({ osKind: 'Windows' }, { skillActive: true })['windows_notes'],
    ).toContain('IMPORTANT: You are on Windows');
    expect(systemPromptVars({ osKind: 'macOS' }, { skillActive: true })['windows_notes']).toBe('');
  });

  it('composes the plugin instructions section only when sections exist', () => {
    const vars = systemPromptVars({ pluginSections: 'PLUGIN_A' }, { skillActive: true });

    expect(vars['plugin_sections']).toContain('# Plugin Instructions');
    expect(vars['plugin_sections']).toContain('PLUGIN_A');
    expect(systemPromptVars({}, { skillActive: true })['plugin_sections']).toBe('');
  });

  it('defaults host-identity variables to the CLI text', () => {
    const vars = systemPromptVars({}, { skillActive: true });

    expect(vars['product_name']).toBe('Kiki');
    expect(vars['reply_style_guide']).toBe(DEFAULT_REPLY_STYLE_GUIDE);
  });

  it('lets the context override host-identity variables', () => {
    const vars = systemPromptVars(
      { productName: 'Kimi Desktop', replyStyleGuide: 'GUI_STYLE' },
      { skillActive: true },
    );

    expect(vars['product_name']).toBe('Kimi Desktop');
    expect(vars['reply_style_guide']).toBe('GUI_STYLE');
  });
});

describe('prompt configuration', () => {
  it('keeps variables and overrides while rejecting removed shared and tools keys', () => {
    expect(PromptConfigSchema.safeParse({ shared: '${missing}' }).success).toBe(false);
    expect(PromptConfigSchema.safeParse({ tools: { WebSearch: '${missing}' } }).success).toBe(false);
    expect(PromptConfigSchema.safeParse({ variables: { 'bad-name': 'text' } }).success).toBe(false);
    for (const name of Object.keys(systemPromptVars({}, { skillActive: false }))) expect(RESERVED_PROMPT_VARIABLES.has(name)).toBe(true);
    for (const name of RESERVED_PROMPT_VARIABLES) expect(PromptConfigSchema.safeParse({ variables: { [name]: 'override' } }).success, name).toBe(false);
    expect(PromptConfigSchema.parse({
      variables: { guidance: 'literal ${shell_code}' },
      overrides: { fields: { 'system.shared': 'Global ${guidance}' } },
    })).toEqual({
      variables: { guidance: 'literal ${shell_code}' },
      overrides: { fields: { 'system.shared': 'Global ${guidance}' } },
    });
  });
});

describe('renderPromptTemplateResult', () => {
  it('substitutes configured variables once while protecting built-in names in standalone profiles', () => {
    const result = renderPromptTemplateResult('${search_guidance}|${cwd}|${ordinary_unknown}', {
      cwd: '/workspace',
      promptVariables: { search_guidance: 'Use native ${literal} GMA.', cwd: 'forged', base_prompt: 'forged' },
    }, { skillActive: false });
    expect(result.text).toBe('Use native ${literal} GMA.|/workspace|${ordinary_unknown}');
  });
  it('substitutes known variables and keeps unknown placeholders verbatim', () => {
    const out = renderPromptTemplateResult(
      'cwd=${cwd} unknown=${nope} bare=$cwd dollar=$${cwd}',
      { cwd: '/work' },
      { skillActive: true },
    ).text;

    expect(out).toBe('cwd=/work unknown=${nope} bare=$cwd dollar=$/work');
  });

  it('resolves ${base_prompt} lazily and only when the template references it', () => {
    let calls = 0;
    const basePrompt = (): SystemPromptRenderResult => {
      calls += 1;
      return {
        text: 'BASE',
        environment: { cwd: '', date: { disclosed: false } },
      };
    };

    expect(
      renderPromptTemplateResult('no base here', {}, { skillActive: true }, basePrompt).text,
    ).toBe('no base here');
    expect(calls).toBe(0);

    expect(
      renderPromptTemplateResult('wrap\n\n${base_prompt}', {}, { skillActive: true }, basePrompt)
        .text,
    ).toBe('wrap\n\nBASE');
    expect(calls).toBe(1);
  });

  it('treats ${parent_prompt} as an alias of ${base_prompt} and binds once', () => {
    let calls = 0;
    const basePrompt = (): SystemPromptRenderResult => {
      calls += 1;
      return {
        text: 'PARENT',
        environment: { cwd: '', date: { disclosed: false } },
      };
    };

    expect(
      renderPromptTemplateResult('wrap\n\n${parent_prompt}', {}, { skillActive: true }, basePrompt)
        .text,
    ).toBe('wrap\n\nPARENT');
    expect(calls).toBe(1);

    expect(
      renderPromptTemplateResult(
        'a=${parent_prompt} b=${base_prompt}',
        {},
        { skillActive: true },
        basePrompt,
      ).text,
    ).toBe('a=PARENT b=PARENT');
    expect(calls).toBe(2);
  });

  it('resolves ${builtin_prompt} from a separate callback', () => {
    const result = renderPromptTemplateResult(
      'parent=${parent_prompt} builtin=${builtin_prompt}',
      {},
      { skillActive: true },
      () => ({
        text: 'EFFECTIVE',
        environment: { cwd: '', date: { disclosed: false } },
      }),
      () => ({
        text: 'BUILTIN',
        environment: { cwd: '', date: { disclosed: false } },
      }),
    );

    expect(result.text).toBe('parent=EFFECTIVE builtin=BUILTIN');
  });

  it('keeps ${builtin_prompt} verbatim when no builtin callback is provided', () => {
    expect(renderPromptTemplateResult('${builtin_prompt}', {}, { skillActive: true }).text).toBe(
      '${builtin_prompt}',
    );
  });

  it('keeps ${base_prompt} verbatim when no base prompt is provided', () => {
    expect(renderPromptTemplateResult('${base_prompt}', {}, { skillActive: true }).text).toBe(
      '${base_prompt}',
    );
  });

  it('records the environment facts used by the now placeholder', () => {
    const result = renderPromptTemplateResult(
      'date=${now} agents=${agents_md}',
      {
        cwd: '/work',
        now: '2026-07-29T00:30:00.000Z',
        timeZone: 'America/Los_Angeles',
        agentsMd: 'AGENTS',
      },
      { skillActive: true },
    );

    expect(result.text).toBe('date=2026-07-29T00:30:00.000Z agents=AGENTS');
    expect(result.environment.cwd).toBe('/work');
    expect(result.environment.date).toMatchObject({
      disclosed: true,
      value: { localDate: '2026-07-28', timeZone: 'America/Los_Angeles' },
    });
  });

  it('merges disclosure metadata from a structured base_prompt render', () => {
    const result = renderPromptTemplateResult(
      'custom\n\n${base_prompt}',
      { cwd: '/work' },
      { skillActive: true },
      () => ({
        text: 'BASE',
        environment: {
          cwd: '/base',
          date: {
            disclosed: true,
            value: { localDate: '2026-07-28', timeZone: 'UTC' },
          },
        },
      }),
    );

    expect(result.text).toBe('custom\n\nBASE');
    expect(result.environment).toEqual({
      cwd: '/work',
      date: {
        disclosed: true,
        value: { localDate: '2026-07-28', timeZone: 'UTC' },
      },
    });
  });
});

describe('renderSystemPromptResult', () => {
  it('keeps the fieldized default template byte-for-byte identical', () => {
    const context = {
      cwd: '/work',
      cwdListing: 'LISTING',
      agentsMd: 'AGENTS',
      skills: 'SKILLS',
      now: '2026-09-14T00:00:00.000Z',
      osKind: 'Linux',
      shellName: 'bash',
      shellPath: '/bin/bash',
    };
    const vars = { ...systemPromptVars(context, { skillActive: true }), role_additional: 'ROLE' };
    expect(renderSystemPromptResult('ROLE', context, { skillActive: true }).text).toBe(
      renderPrompt(SYSTEM_PROMPT_TEMPLATE, vars),
    );
  });

  it('replaces registered system sections before rendering variables', () => {
    const prompt = renderSystemPromptResult('', {
      promptFields: {
        'system.language': '# Language\n\nCUSTOM LANGUAGE',
        'system.reply_style': 'CUSTOM STYLE ${reply_style_guide}',
        'system.coding': '# General Guidelines for Coding\n\nCUSTOM CODING',
      },
    }, { skillActive: true }).text;
    expect(prompt).toContain('CUSTOM LANGUAGE');
    expect(prompt).toContain(`CUSTOM STYLE ${DEFAULT_REPLY_STYLE_GUIDE}`);
    expect(prompt).toContain('CUSTOM CODING');
    expect(prompt).not.toContain("Write in the user's language");
  });

  it.each(['$&', "$'", "$'\n'"])('treats %s literally in section and reply-style replacements', (literal) => {
    const language = `# Language\n\nLITERAL ${literal}`;
    const replyStyle = `STYLE ${literal}`;
    const prompt = applySystemPromptFields({
      'system.language': language,
      'system.reply_style': replyStyle,
    });
    expect(prompt.split(language)).toHaveLength(2);
    expect(prompt.split(replyStyle)).toHaveLength(2);
    expect(prompt.split('# Ultimate Reminders')).toHaveLength(2);
    expect(prompt).not.toContain("Write in the user's language");
  });

  it('places the role text at the role slot and injects context sections', () => {
    const prompt = renderSystemPromptResult(
      'ROLE_TEXT',
      { agentsMd: 'AGENTS', skills: 'SKILLS', cwd: '/work' },
      { skillActive: true },
    ).text;

    expect(prompt).toContain('ROLE_TEXT');
    expect(prompt).toContain('AGENTS');
    expect(prompt).toContain('/work');
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('SKILLS');
  });

  it('omits the skills section when the profile disables the Skill tool', () => {
    const prompt = renderSystemPromptResult('', { skills: 'SKILLS' }, { skillActive: false }).text;

    expect(prompt).not.toContain('# Skills');
    expect(prompt).not.toContain('SKILLS');
  });

  it('shows Windows notes only on Windows', () => {
    expect(
      renderSystemPromptResult('', { osKind: 'Windows' }, { skillActive: true }).text,
    ).toContain('IMPORTANT: You are on Windows');
    expect(
      renderSystemPromptResult('', { osKind: 'macOS' }, { skillActive: true }).text,
    ).not.toContain('IMPORTANT: You are on Windows');
  });

  it('shows the additional directories section only when directories exist', () => {
    expect(
      renderSystemPromptResult('', { additionalDirsInfo: '/extra' }, { skillActive: true }).text,
    ).toContain('## Additional Directories');
    expect(renderSystemPromptResult('', {}, { skillActive: true }).text).not.toContain(
      '## Additional Directories',
    );
  });

  it('shows the plugin instructions section only when plugin sections exist', () => {
    const prompt = renderSystemPromptResult(
      '',
      { pluginSections: 'PLUGIN_A' },
      { skillActive: true },
    ).text;

    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_A');
    expect(renderSystemPromptResult('', {}, { skillActive: true }).text).not.toContain(
      '# Plugin Instructions',
    );
  });

  it('renders the builtin template with no leftover placeholders', () => {
    const prompt = renderSystemPromptResult(
      'ROLE_TEXT',
      {
        skills: 'SKILLS',
        agentsMd: 'AGENTS',
        cwd: '/work',
        cwdListing: 'LISTING',
        osKind: 'Windows',
        shellName: 'cmd',
        shellPath: 'C:\\cmd.exe',
        now: 'NOW',
        additionalDirsInfo: '/extra',
      },
      { skillActive: true },
    ).text;

    expect(prompt).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/);
  });

  it('renders the host identity from the context, defaulting to Kiki', () => {
    const fallback = renderSystemPromptResult('', {}, { skillActive: true }).text;
    expect(fallback).toContain('You are Kiki,');
    expect(fallback).toContain('`<home>/docs`');
    expect(fallback).toContain('do not consult upstream Kimi Code sites');
    expect(fallback).toContain(DEFAULT_REPLY_STYLE_GUIDE);

    const overridden = renderSystemPromptResult(
      '',
      { productName: 'Kimi Desktop', replyStyleGuide: 'GUI_STYLE' },
      { skillActive: true },
    ).text;
    expect(overridden).toContain('You are Kimi Desktop,');
    expect(overridden).toContain('GUI_STYLE');
    expect(overridden).not.toContain('You are Kiki,');
  });

  it('returns disclosure metadata for the builtin now section', () => {
    const result = renderSystemPromptResult(
      '',
      {
        cwd: '/work',
        now: '2026-07-29T12:00:00',
        agentsMd: 'AGENTS',
      },
      { skillActive: true },
    );

    expect(result.text).toContain('AGENTS');
    expect(result.environment.cwd).toBe('/work');
    expect(result.environment.date).toMatchObject({
      disclosed: true,
      value: { localDate: '2026-07-29' },
    });
  });
});

describe('normalizeAgentProfile', () => {
  it('derives a disclosure-free renderSystemPrompt for text-only input', () => {
    const profile = normalizeAgentProfile({
      name: 'text-only',
      systemPrompt: (context) => `cwd:${context.cwd ?? ''}`,
    });

    expect(profile.renderSystemPrompt({ cwd: '/work' })).toEqual({
      text: 'cwd:/work',
      environment: { cwd: '/work', date: { disclosed: false } },
    });
    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'cwd:',
      environment: { cwd: '', date: { disclosed: false } },
    });
  });

  it('derives systemPrompt from renderSystemPrompt for structured input', () => {
    const render = (context: AgentProfileContext): SystemPromptRenderResult => ({
      text: `structured:${context.cwd ?? ''}`,
      environment: {
        cwd: context.cwd ?? '',
        date: {
          disclosed: true,
          value: { localDate: '2026-07-29', timeZone: 'UTC' },
        },
      },
    });
    const profile = normalizeAgentProfile({ name: 'structured', renderSystemPrompt: render });

    expect(profile.systemPrompt({ cwd: '/work' })).toBe('structured:/work');
    expect(profile.systemPrompt({ cwd: '/work' })).toBe(
      profile.renderSystemPrompt({ cwd: '/work' }).text,
    );
    expect(profile.renderSystemPrompt({ cwd: '/work' }).environment).toEqual({
      cwd: '/work',
      date: {
        disclosed: true,
        value: { localDate: '2026-07-29', timeZone: 'UTC' },
      },
    });
  });

  it('falls back to systemPrompt when renderSystemPrompt is explicitly undefined', () => {
    const profile = normalizeAgentProfile({
      name: 'legacy-undefined',
      systemPrompt: () => 'text-entry',
      renderSystemPrompt: undefined,
    });

    expect(profile.systemPrompt({})).toBe('text-entry');
    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'text-entry',
      environment: { cwd: '', date: { disclosed: false } },
    });
  });

  it('rejects a profile without any render entry', () => {
    const renderless = { name: 'empty' } as unknown as AgentProfileInput;
    expect(() => normalizeAgentProfile(renderless)).toThrow(
      /must define systemPrompt or renderSystemPrompt/,
    );
  });

  it('keeps the input object as receiver for a method-style text-only profile', () => {
    const input = {
      name: 'method-text',
      systemPrompt() {
        return `name:${this.name}`;
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.systemPrompt({})).toBe('name:method-text');
    expect(profile.renderSystemPrompt({}).text).toBe('name:method-text');
  });

  it('keeps the input object as receiver for a method-style structured profile', () => {
    const input = {
      name: 'method-structured',
      renderSystemPrompt(): SystemPromptRenderResult {
        return {
          text: `name:${this.name}`,
          environment: { cwd: '', date: { disclosed: false } },
        };
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.renderSystemPrompt({}).text).toBe('name:method-structured');
    expect(profile.systemPrompt({})).toBe('name:method-structured');
  });

  it('prefers the structured entry when both are given and keeps cross-entry this calls working', () => {
    const input = {
      name: 'both',
      systemPrompt(_context: AgentProfileContext) {
        return 'text-entry';
      },
      renderSystemPrompt(context: AgentProfileContext): SystemPromptRenderResult {
        return {
          text: `structured:${this.systemPrompt(context)}`,
          environment: { cwd: context.cwd ?? '', date: { disclosed: false } },
        };
      },
    };
    const profile = normalizeAgentProfile(input);

    expect(profile.renderSystemPrompt({})).toEqual({
      text: 'structured:text-entry',
      environment: { cwd: '', date: { disclosed: false } },
    });
    expect(profile.systemPrompt({})).toBe('structured:text-entry');
  });

  it('registerAgentProfile rejects a renderless profile without touching the registry', () => {
    _clearAgentProfileContributionsForTests();
    try {
      registerAgentProfile({ name: 'kept', systemPrompt: () => 'text' });
      const renderless = { name: 'empty' } as unknown as AgentProfileInput;
      expect(() => registerAgentProfile(renderless)).toThrow(
        /must define systemPrompt or renderSystemPrompt/,
      );
      expect(getAgentProfileContributions().map((profile) => profile.name)).toEqual(['kept']);
    } finally {
      _clearAgentProfileContributionsForTests();
    }
  });
});
