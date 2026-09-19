import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_PROFILE_NAME,
  normalizeAgentProfile,
  type AgentProfile,
} from '#/agentProfile';
import type { HostFs } from '#/hostFs';
import {
  SYSTEM_MD_FILENAME,
  loadSystemMdProfile,
} from '#/systemFile';

import { HostFsError, nodeHostFs as hostFs, OsFsErrors } from './nodeHostFs';

const BUILTIN_DEFAULT: AgentProfile = normalizeAgentProfile({
  name: DEFAULT_AGENT_PROFILE_NAME,
  description: 'builtin default description',
  main: true,
  tools: ['Read', 'Skill', 'Bash'],
  disallowedTools: ['Write'],
  systemPrompt: () => 'BUILTIN PROMPT',
});

function collectWarnings(): { warnings: string[]; warn: (message: string) => void } {
  const warnings: string[] = [];
  return { warnings, warn: (message) => warnings.push(message) };
}

describe('loadSystemMdProfile', () => {
  let home: string;

  function loadProfile(
    fs: HostFs,
    builtinDefault: AgentProfile,
    warn: (message: string) => void,
  ) {
    return loadSystemMdProfile(fs, home, builtinDefault, warn);
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'system-md-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });

  it('returns undefined when SYSTEM.md does not exist', async () => {
    const { warnings, warn } = collectWarnings();
    expect(await loadProfile(hostFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('returns undefined when SYSTEM.md is empty or whitespace-only', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), ' \n\n');
    const { warn } = collectWarnings();
    expect(await loadProfile(hostFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
  });

  it('degrades to a warning when the file cannot be read', async () => {
    const unreadableFs = {
      realpath: async (p: string) => p,
      stat: async () => ({ isFile: true }),
      readFile: async () => {
        throw new Error('disk gone');
      },
    } as unknown as HostFs;
    const { warnings, warn } = collectWarnings();

    expect(await loadProfile(unreadableFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SYSTEM.md');
  });

  it('degrades to a warning when the SYSTEM.md type probe is denied', async () => {
    const unreadableFs = {
      realpath: async () => {
        throw new HostFsError(
          OsFsErrors.codes.OS_FS_PERMISSION_DENIED,
          'realpath failed: permission denied',
        );
      },
    } as unknown as HostFs;
    const { warnings, warn } = collectWarnings();

    expect(await loadProfile(unreadableFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SYSTEM.md');
  });

  it('synthesizes a default-named override profile that inherits the builtin shape', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'You are a custom main agent.');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.name).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(profile?.override).toBe(true);
    expect(profile?.main).toBe(true);
    expect(profile?.sourcePath).toBe(join(home, SYSTEM_MD_FILENAME));
    expect(profile?.description).toBe('builtin default description');
    expect(profile?.tools).toEqual(['Read', 'Skill', 'Bash']);
    expect(profile?.disallowedTools).toEqual(['Write']);
    expect(profile?.systemPrompt({})).toBe('You are a custom main agent.');
  });

  it('empties ${skills} when the builtin default disables the Skill tool', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'skills=${skills}');
    const noSkillBuiltin: AgentProfile = normalizeAgentProfile({
      name: DEFAULT_AGENT_PROFILE_NAME,
      description: 'builtin without Skill',
      tools: ['Read', 'Bash'],
      systemPrompt: () => 'BUILTIN PROMPT',
    });
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, noSkillBuiltin, warn);

    expect(profile?.systemPrompt({ skills: 'SKILLS' })).toBe('skills=');
  });

  it('embeds the builtin default prompt via ${base_prompt}', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'custom header\n\n${base_prompt}');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({})).toBe('custom header\n\nBUILTIN PROMPT');
  });

  it('embeds the builtin default prompt via ${parent_prompt} and ${builtin_prompt}', async () => {
    await writeFile(
      join(home, SYSTEM_MD_FILENAME),
      'parent=${parent_prompt}\nbuiltin=${builtin_prompt}',
    );
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({})).toBe('parent=BUILTIN PROMPT\nbuiltin=BUILTIN PROMPT');
  });

  it('places plugin instructions where ${plugin_sections} is referenced', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'before\n${plugin_sections}after');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);
    const prompt = profile?.systemPrompt({ pluginSections: 'PLUGIN_INSTRUCTIONS' });

    expect(prompt).toContain('before');
    expect(prompt).toContain('# Plugin Instructions');
    expect(prompt).toContain('PLUGIN_INSTRUCTIONS');
    expect(prompt).toContain('after');
  });

  it('substitutes ${additional_dirs_info} from the context', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), 'dirs=${additional_dirs_info}');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({ additionalDirsInfo: '/extra' })).toBe('dirs=/extra');
  });

  it('loads an upgraded SYSTEM.md with frontmatter as a default-named override', async () => {
    await writeFile(
      join(home, SYSTEM_MD_FILENAME),
      [
        '---',
        'name: other',
        'description: upgraded default',
        'tools:',
        '  - Read',
        'override: false',
        '---',
        '',
        'UPGRADED ${parent_prompt}',
        '',
      ].join('\n'),
    );
    const { warnings, warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.name).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(profile?.override).toBe(true);
    expect(profile?.description).toBe('upgraded default');
    expect(profile?.tools).toEqual(['Read']);
    expect(profile?.disallowedTools).toEqual(['Write']);
    expect(Object.hasOwn(profile ?? {}, 'promptPrefix')).toBe(false);
    expect(profile?.summaryPolicy).toBeUndefined();
    expect(profile?.systemPrompt({})).toBe('UPGRADED BUILTIN PROMPT');
    expect(warnings.some((message) => message.includes('name "other"'))).toBe(true);
    expect(warnings.some((message) => message.includes('override false'))).toBe(true);
  });

  it('preserves an explicit main: false in upgraded SYSTEM.md', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\nmain: false\n---\nSubagent-only prompt.');
    const { warn } = collectWarnings();
    expect((await loadProfile(hostFs, BUILTIN_DEFAULT, warn))?.main).toBe(false);
  });

  it('does not accept an external executor through inherited main status', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\nexecutor: example-acp\n---\nExternal prompt.');
    const { warnings, warn } = collectWarnings();
    expect(await loadProfile(hostFs, BUILTIN_DEFAULT, warn)).toBeUndefined();
    expect(warnings.join(' ')).toContain('unsupported for main');
  });

  it('inherits builtin tools when an upgraded SYSTEM.md omits them', async () => {
    await writeFile(
      join(home, SYSTEM_MD_FILENAME),
      '---\ndescription: inherit tools\n---\n\nbody only\n',
    );
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.description).toBe('inherit tools');
    expect(profile?.tools).toEqual(['Read', 'Skill', 'Bash']);
    expect(profile?.disallowedTools).toEqual(['Write']);
    expect(profile?.systemPrompt({})).toBe('body only');
  });

  it('inherits recommendations only for an explicit subagent policy and keeps omission implicit', async () => {
    const builtin = normalizeAgentProfile({
      ...BUILTIN_DEFAULT,
      subagentPolicy: 'advisory',
      subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });
    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\nsubagent_policy: advisory\n---\n\nbody\n');
    const { warn } = collectWarnings();
    const advisory = await loadProfile(hostFs, builtin, warn);
    expect(advisory).toMatchObject({
      subagentPolicy: 'advisory',
      subagentDeclaration: { kind: 'set', names: ['explore'] },
      subagents: ['explore'],
    });

    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\n---\n\nunmarked upgraded\n');
    const unmarked = await loadProfile(hostFs, builtin, warn);
    expect(unmarked?.subagentPolicy).toBeUndefined();
    expect(unmarked?.subagentDeclaration).toBeUndefined();
    expect(unmarked?.subagents).toEqual(['explore']);
  });

  it('defaults an upgraded SYSTEM.md description to the builtin when omitted', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\n---\n\nno description\n');
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.main).toBe(true);
    expect(profile?.sourcePath).toBe(join(home, SYSTEM_MD_FILENAME));
    expect(profile?.description).toBe('builtin default description');
    expect(profile?.systemPrompt({})).toBe('no description');
  });

  it('loads upgraded SYSTEM.md in inherit mode without a body', async () => {
    await writeFile(
      join(home, SYSTEM_MD_FILENAME),
      '---\nsystem_prompt_mode: inherit\nprompt_overrides:\n  fields:\n    system.language: concise\n---\n',
    );
    const { warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPromptMode).toBe('inherit');
    expect(profile?.promptOverrides).toEqual({ fields: { 'system.language': 'concise' } });
    expect(profile?.fileDefinition).toMatchObject({ prompt: '', systemPromptMode: 'inherit' });
    expect(profile?.systemPrompt({})).toBe('BUILTIN PROMPT');
  });

  it('treats a SYSTEM.md whose frontmatter is not a mapping as a legacy prompt', async () => {
    await writeFile(join(home, SYSTEM_MD_FILENAME), '---\n- listed\n---\nlegacy body\n');
    const { warnings, warn } = collectWarnings();

    const profile = await loadProfile(hostFs, BUILTIN_DEFAULT, warn);

    expect(profile?.systemPrompt({})).toContain('---');
    expect(profile?.systemPrompt({})).toContain('legacy body');
    expect(profile?.tools).toEqual(['Read', 'Skill', 'Bash']);
    expect(warnings.some((message) => message.includes('not a mapping'))).toBe(true);
  });

  it('reports invalid upgraded YAML instead of loading it as a legacy prompt', async () => {
    const path = join(home, SYSTEM_MD_FILENAME);
    await writeFile(path, '---\nmodel_alias: [broken\n---\ninvalid yaml body\n');
    const { warnings, warn } = collectWarnings();
    const failures: Array<{ path: string; reason: string }> = [];

    const profile = await loadSystemMdProfile(hostFs, home, BUILTIN_DEFAULT, warn, (failure) => failures.push(failure));

    expect(profile).toBeUndefined();
    expect(failures).toEqual([{ path, reason: expect.stringContaining('SYSTEM.md parse failed'), code: 'agent_profile.system_invalid' }]);
    expect(warnings.some((message) => message.includes('SYSTEM.md parse failed'))).toBe(true);
    expect(warnings.join(' ')).not.toContain('legacy prompt');
  });
});
