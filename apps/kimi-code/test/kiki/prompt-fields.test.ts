import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import type {
  PromptFieldDefinitionInfo,
  PromptFieldInspection,
} from '@kiki/node-sdk';

import {
  registerPromptFieldsCommand,
  type PromptFieldsCommandDeps,
} from '#/kiki/prompt-fields';

const field: PromptFieldDefinitionInfo = {
  id: 'system.language',
  owner: 'systemPrompt',
  consumers: ['system'],
  overridable: true,
  allowEmpty: false,
  allowedVariables: ['product_name'],
  requiredPlaceholders: ['product_name'],
  defaultKind: 'inline',
  defaultValue: 'You are ${product_name}.',
};

function inspection(overrides: Partial<PromptFieldInspection> = {}): PromptFieldInspection {
  return {
    profile: 'agent',
    model: 'fast',
    executor: 'native',
    delegationPosition: 'main',
    warnings: [],
    validation: {
      configPath: '/home/example/.kiki/config.toml',
      fieldCount: 1,
      modelCount: 1,
      profileCount: 3,
      systemMdLoaded: true,
      externalFileCount: 1,
    },
    fields: [{
      ...field,
      status: 'effective',
      value: 'Configured language',
      sources: [
        { surface: 'default', kind: 'default', status: 'shadowed' },
        {
          surface: 'global',
          kind: 'file',
          status: 'shadowed',
          path: 'base.toml',
          fileIndex: 0,
          line: 3,
        },
        {
          surface: 'profile',
          kind: 'inline',
          status: 'effective',
          path: '/home/example/.kiki/SYSTEM.md',
        },
      ],
    }],
    ...overrides,
  };
}

function makeDeps(report = inspection()): {
  readonly deps: PromptFieldsCommandDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exits: number[];
  readonly inspect: ReturnType<typeof vi.fn>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const inspect = vi.fn(async () => report);
  return {
    deps: {
      cwd: () => '/workspace',
      resolveHome: (home) => home ?? '/home/example/.kiki',
      list: () => [field],
      inspect,
      stdout: { write: (chunk) => stdout.push(chunk) > 0 },
      stderr: { write: (chunk) => stderr.push(chunk) > 0 },
      exit: (code) => {
        exits.push(code);
        throw new Error(`exit ${String(code)}`);
      },
    },
    stdout,
    stderr,
    exits,
    inspect,
  };
}

async function parse(args: readonly string[], deps: PromptFieldsCommandDeps): Promise<void> {
  const program = new Command('kiki').exitOverride();
  registerPromptFieldsCommand(program, deps);
  await program.parseAsync(['node', 'kiki', ...args]);
}

describe('kiki prompt-fields', () => {
  it('lists discoverable fields with ownership, consumers, and override policy', async () => {
    const { deps, stdout, stderr } = makeDeps();

    await parse(['prompt-fields'], deps);

    expect(stderr.join('')).toBe('');
    expect(stdout.join('')).toContain('ID\tOWNER\tCONSUMERS\tOVERRIDE');
    expect(stdout.join('')).toContain('system.language\tsystemPrompt\tsystem\tyes');
    expect(stdout.join('')).toContain('1 prompt fields.');
  });

  it('shows the default and variable contract for one field', async () => {
    const { deps, stdout } = makeDeps();

    await parse(['prompt-fields', 'show', 'system.language'], deps);

    const text = stdout.join('');
    expect(text).toContain('Allowed variables: product_name');
    expect(text).toContain('Required placeholders: product_name');
    expect(text).toContain('Default value:\nYou are ${product_name}.');
  });

  it('validates an external config path with the selected context', async () => {
    const { deps, stdout, inspect } = makeDeps();

    await parse([
      'prompt-fields',
      'validate',
      './candidate.toml',
      '--home',
      '/other-home',
      '--agent',
      'reviewer',
      '--model',
      'fast',
      '--delegation-position',
      'sub',
    ], deps);

    expect(inspect).toHaveBeenCalledWith({
      homeDir: '/other-home',
      configPath: './candidate.toml',
      cwd: '/workspace',
      profile: 'reviewer',
      model: 'fast',
      executor: undefined,
      delegationPosition: 'sub',
    });
    const text = stdout.join('');
    expect(text).toContain('OK prompt field configuration is valid.');
    expect(text).toContain('SYSTEM.md: loaded');
    expect(text).toContain('External override files: 1');
  });

  it('explains the source chain and current effective value', async () => {
    const { deps, stdout } = makeDeps();

    await parse(['prompt-fields', 'explain', 'system.language'], deps);

    const text = stdout.join('');
    expect(text).toContain('Status: effective');
    expect(text).toContain('shadowed\tdefault');
    expect(text).toContain('shadowed\tglobal:file[0] base.toml:3');
    expect(text).toContain('effective\tprofile:inline /home/example/.kiki/SYSTEM.md');
    expect(text).toContain('Effective value:\nConfigured language');
  });

  it('reports inactive fields without an effective value', async () => {
    const report = inspection({
      fields: [{
        ...field,
        status: 'inactive',
        value: undefined,
        sources: [{ surface: 'default', kind: 'default', status: 'inactive' }],
      }],
    });
    const { deps, stdout } = makeDeps(report);

    await parse(['prompt-fields', 'explain', 'system.language'], deps);

    expect(stdout.join('')).toContain('Status: inactive');
    expect(stdout.join('')).toContain('Effective value: (none)');
  });

  it('fails read-only validation with a non-zero exit and a concise error', async () => {
    const { deps, stdout, stderr, exits } = makeDeps();
    const broken = {
      ...deps,
      inspect: vi.fn(() => Promise.reject(new Error('Unknown prompt field "system.typo"'))),
    };

    await expect(parse(['prompt-fields', 'validate'], broken)).rejects.toThrow('exit 1');

    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('Prompt field inspection failed: Unknown prompt field "system.typo"');
    expect(exits).toEqual([1]);
  });
});
