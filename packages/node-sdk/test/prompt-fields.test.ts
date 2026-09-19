import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectPromptFields, listPromptFieldDefinitions } from '#/index';

let dir: string;
let homeDir: string;
let workDir: string;
let osHomeDir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `kiki-prompt-fields-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  homeDir = join(dir, 'home');
  workDir = join(dir, 'workspace');
  osHomeDir = join(dir, 'os-home');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(workDir, { recursive: true }),
    mkdir(osHomeDir, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('prompt field inspection', () => {
  it('lists every built-in field with registry metadata', () => {
    const fields = listPromptFieldDefinitions();

    // Anchor: 73 fields after the Tower tool retirement (11 tools x 2 fields
    // left the registry); the count only moves when tools/system sections do.
    expect(fields.length).toBeGreaterThanOrEqual(70);
    expect(fields.find((field) => field.id === 'system.language')).toMatchObject({
      owner: 'systemPrompt',
      consumers: ['system'],
      overridable: true,
      defaultKind: 'inline',
    });
    expect(fields.find((field) => field.id === 'tool.bash.description')).toMatchObject({
      owner: 'tool.bash',
      consumers: ['tool:Bash'],
      defaultKind: 'resource',
    });
  });

  it('validates all surfaces and explains the complete precedence chain', async () => {
    await writeFile(
      join(homeDir, 'base.toml'),
      'schema_version = 1\n[fields]\n"system.shared" = "global file"\n',
      'utf8',
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      [
        'default_model = "fast"',
        '',
        '[prompt.overrides]',
        'files = ["base.toml"]',
        '',
        '[prompt.overrides.fields]',
        '"system.shared" = "global inline"',
        '',
        '[models.fast]',
        'provider = "example"',
        'model = "fast"',
        '',
        '[models.fast.prompt_overrides.fields]',
        '"system.shared" = "model inline"',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(homeDir, 'SYSTEM.md'),
      [
        '---',
        'description: Default agent override',
        'system_prompt_mode: inherit',
        'prompt_overrides:',
        '  fields:',
        '    system.shared: profile inline',
        'model_profiles:',
        '  - alias: fast',
        '    prompt_overrides:',
        '      fields:',
        '        system.shared: profile model inline',
        '---',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = await inspectPromptFields({ homeDir, cwd: workDir, osHomeDir });

    expect(report.validation).toMatchObject({
      fieldCount: listPromptFieldDefinitions().length,
      modelCount: 1,
      systemMdLoaded: true,
      externalFileCount: 1,
    });
    expect(report.profile).toBe('agent');
    expect(report.model).toBe('fast');
    const shared = report.fields.find((field) => field.id === 'system.shared');
    expect(shared).toMatchObject({ status: 'effective', value: 'profile model inline' });
    expect(shared?.sources.map((source) => `${source.status}:${source.surface}:${source.kind}`)).toEqual([
      'shadowed:default:default',
      'shadowed:global:file',
      'shadowed:global:inline',
      'shadowed:model:inline',
      'shadowed:system:inline',
      'effective:profile-model:inline',
    ]);
    expect(report.fields.find((field) => field.id === 'system.language')?.status).toBe('effective');
    expect(report.fields.find((field) => field.id === 'delegation.sub.notice')?.status).toBe('inactive');
  });

  it('rejects unknown fields in an externally referenced TOML file', async () => {
    await writeFile(
      join(homeDir, 'unknown.toml'),
      'schema_version = 1\n[fields]\n"system.typo" = "bad"\n',
      'utf8',
    );
    await writeFile(
      join(homeDir, 'config.toml'),
      '[prompt.overrides]\nfiles = ["unknown.toml"]\n',
      'utf8',
    );

    await expect(inspectPromptFields({ homeDir, cwd: workDir, osHomeDir })).rejects.toThrow(
      'Unknown prompt field "system.typo"',
    );
  });

  it('marks system fields shadowed for a legacy SYSTEM.md body', async () => {
    await writeFile(join(homeDir, 'SYSTEM.md'), 'Custom complete system prompt.\n', 'utf8');

    const report = await inspectPromptFields({ homeDir, cwd: workDir, osHomeDir });

    expect(report.validation.systemMdLoaded).toBe(true);
    expect(report.fields.find((field) => field.id === 'system.language')).toMatchObject({
      status: 'shadowed',
      value: undefined,
    });
    expect(report.fields.find((field) => field.id === 'system.shared')?.status).toBe('effective');
  });

  it('resolves the shipped built-in profiles without any on-disk agent files', async () => {
    const report = await inspectPromptFields({ homeDir, cwd: workDir, osHomeDir });

    expect(report.profile).toBe('agent');
    expect(report.validation.systemMdLoaded).toBe(false);
    expect(report.fields.find((field) => field.id === 'system.language')).toMatchObject({
      status: 'effective',
    });

    const explore = await inspectPromptFields({ homeDir, cwd: workDir, osHomeDir, profile: 'explore' });
    expect(explore.profile).toBe('explore');
    expect(explore.validation.profileCount).toBeGreaterThanOrEqual(5);
  });
});
