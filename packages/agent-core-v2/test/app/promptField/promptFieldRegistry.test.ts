import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AGENT_DESCRIPTION_BASE from '../../../src/agent/tools/agent/agent.md?raw';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter, Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { PromptConfigSchema } from '#/app/prompt/configSection';
import {
  applyToolPromptFields,
  BUILTIN_PROMPT_FIELD_DEFINITIONS,
} from '#/app/promptField/builtinPromptFields';
import {
  _clearPromptFieldContributionsForTests,
  PromptFieldContribution,
  registerPromptField,
} from '#/app/promptField/promptFieldContribution';
import { IPromptFieldRegistry, type PromptFieldDefinition } from '#/app/promptField/promptFieldRegistry';
import { PromptFieldRegistryService } from '#/app/promptField/promptFieldRegistryService';
import { readPromptOverrideFile } from '#/app/promptField/promptOverrideFile';
import { ModelsSectionSchema, modelsFromToml, modelsToToml } from '#/app/kosongConfig/configSection';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService, type HostFsChange } from '#/os/interface/hostFsWatch';

const HOME = '/home/example/.kiki';

interface ITestPromptFieldContributor {
  readonly _serviceBrand: undefined;
}

const ITestPromptFieldContributor = createDecorator<ITestPromptFieldContributor>('testPromptFieldContributor');

class TestPromptFieldContributor extends Service implements ITestPromptFieldContributor {
  declare readonly _serviceBrand: undefined;

  constructor(field: PromptFieldDefinition) {
    super();
    this.provide(PromptFieldContribution, { definition: field });
  }
}

function definition(
  id: string,
  options: Partial<PromptFieldDefinition> = {},
): PromptFieldDefinition {
  return {
    id,
    owner: 'test',
    defaultTemplate: { kind: 'inline', value: 'default' },
    allowedVariables: [],
    requiredPlaceholders: [],
    allowEmpty: false,
    readonly: false,
    consumers: ['system'],
    contractVersion: 1,
    ...options,
  };
}

function fileSystem(files: Readonly<Record<string, string>>, realpaths: Readonly<Record<string, string>> = {}): IHostFileSystem {
  const stat = (path: string): HostFileStat => ({
    isFile: path !== HOME,
    isDirectory: path === HOME,
    size: files[path]?.length ?? 0,
  });
  return {
    _serviceBrand: undefined,
    realpath: async (path) => realpaths[path] ?? path,
    stat: async (path) => stat(path),
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
  } as IHostFileSystem;
}

function bootstrap(): IBootstrapService {
  return {
    _serviceBrand: undefined,
    homeDir: HOME,
    platform: 'linux',
  } as IBootstrapService;
}

function createRegistry(
  fs: IHostFileSystem = fileSystem({}),
  watchEvent: Event<HostFsChange> = Event.None as Event<HostFsChange>,
): {
  readonly services: TestInstantiationService;
  readonly registry: IPromptFieldRegistry;
} {
  const services = new TestInstantiationService();
  services.set(IHostFileSystem, fs);
  services.set(IHostFsWatchService, {
    _serviceBrand: undefined,
    watch: () => ({ ready: Promise.resolve(), onDidChange: watchEvent, dispose: () => {} }),
  });
  services.set(IBootstrapService, bootstrap());
  services.set(IPromptFieldRegistry, new SyncDescriptor(PromptFieldRegistryService));
  return { services, registry: services.get(IPromptFieldRegistry) };
}

describe('PromptFieldRegistryService', () => {
  let services: TestInstantiationService | undefined;

  beforeEach(() => {
    _clearPromptFieldContributionsForTests();
    registerPromptField(definition('system.language'));
    registerPromptField(definition('system.shared', { allowEmpty: true }));
    registerPromptField(definition('system.safety', { readonly: true }));
    registerPromptField(definition('system.identity', {
      allowedVariables: ['product_name'],
      requiredPlaceholders: ['product_name'],
    }));
    registerPromptField(definition('tool.bash.description', {
      appliesTo: { models: ['fast-model'] },
    }));
  });

  afterEach(() => {
    services?.dispose();
    services = undefined;
    _clearPromptFieldContributionsForTests();
  });

  it('registers system, delegation, and static tool field definitions', () => {
    const ids = new Set(BUILTIN_PROMPT_FIELD_DEFINITIONS.map((field) => field.id));
    expect(ids).toContain('system.language');
    expect(ids).toContain('system.reply_style');
    expect(ids).toContain('system.ultimate_reminders');
    expect(ids).toContain('delegation.sub.notice');
    expect(ids).toContain('tool.agent-run.description');
    expect(ids).toContain('tool.tower-status.guidance');
  });

  it('replaces only the static AgentRun description and preserves its dynamic projection', () => {
    const description = `${AGENT_DESCRIPTION_BASE}\n\nDYNAMIC PROFILE LIST`;
    const rendered = applyToolPromptFields('AgentRun', description, {
      values: {
        'tool.agent-run.description': 'CUSTOM AGENT',
        'tool.agent-run.guidance': 'CUSTOM GUIDANCE',
      },
      fields: [],
    });
    expect(rendered).toBe('CUSTOM AGENT\n\nDYNAMIC PROFILE LIST\n\nUser-configured guidance:\nCUSTOM GUIDANCE');
  });

  it('aggregates static registrations and rejects duplicate ids', () => {
    ({ services } = createRegistry());
    expect(services.get(IPromptFieldRegistry).list().map((item) => item.id)).toEqual([
      'system.language',
      'system.shared',
      'system.safety',
      'system.identity',
      'tool.bash.description',
    ]);
    expect(() => registerPromptField(definition('system.language'))).toThrow(/more than once/);
  });

  it('folds runtime collection contributions into the live registry', () => {
    ({ services } = createRegistry());
    services.set(
      ITestPromptFieldContributor,
      new SyncDescriptor(TestPromptFieldContributor, [definition('system.coding')] as never),
    );
    services.get(ITestPromptFieldContributor);
    expect(services.get(IPromptFieldRegistry).get('system.coding')).toMatchObject({ owner: 'test' });
  });

  it('validates unknown keys, empty values, readonly fields, and applicability', () => {
    ({ services } = createRegistry());
    const registry = services.get(IPromptFieldRegistry);
    expect(() => registry.validate({ values: { 'system.unknown': 'x' }, sources: {} })).toThrow(/Unknown prompt field/);
    expect(() => registry.validate({ values: { 'system.language': '' }, sources: {} })).toThrow(/does not allow an empty/);
    expect(() => registry.validate({ values: { 'system.safety': 'override' }, sources: {} })).toThrow(/readonly/);
    expect(registry.validate({ values: { 'system.shared': '' }, sources: {} }).fields[0]?.status).toBe('effective');
    expect(registry.validate({ values: { 'tool.bash.description': 'x' }, sources: {} }, { modelAlias: 'slow-model' }).fields[0]?.status).toBe('inactive');
  });

  it('validates allowed, custom, reserved, unknown, and required variables', () => {
    ({ services } = createRegistry());
    const registry = services.get(IPromptFieldRegistry);
    expect(registry.validate({
      values: { 'system.identity': 'You are ${product_name}; ${custom_style}' },
      sources: {},
    }, {}, { custom_style: 'concise' }).fields[0]?.status).toBe('effective');
    expect(() => registry.validate({
      values: { 'system.identity': '${base_prompt} ${product_name}' },
      sources: {},
    })).toThrow(/reserved variable/);
    expect(() => registry.validate({
      values: { 'system.identity': '${missing} ${product_name}' },
      sources: {},
    })).toThrow(/unknown variable/);
    expect(() => registry.validate({
      values: { 'system.identity': 'No identity placeholder' },
      sources: {},
    })).toThrow(/must retain placeholder/);
  });

  it.each(['profile', 'system'] as const)('merges all scopes and the %s surface with file order before inline fields', async (profileSurface) => {
    const files = {
      [`${HOME}/g1.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "g1"\n',
      [`${HOME}/g2.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "g2"\n',
      [`${HOME}/m.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "m-file"\n',
      [`${HOME}/p.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "p-file"\n',
      [`${HOME}/pm.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "pm-file"\n',
    };
    ({ services } = createRegistry(fileSystem(files)));
    const resolved = await services.get(IPromptFieldRegistry).resolve({
      global: { surface: 'global', overrides: { files: ['g1.toml', 'g2.toml'], fields: { 'system.language': 'g-inline' } } },
      model: { surface: 'model', overrides: { files: ['m.toml'], fields: { 'system.language': 'm-inline' } } },
      profile: { surface: profileSurface, sourcePath: '/agents/example.md', overrides: { files: ['p.toml'], fields: { 'system.language': 'p-inline' } } },
      profileModel: { surface: 'profile-model', overrides: { files: ['pm.toml'], fields: { 'system.language': 'pm-inline' } } },
    });

    expect(resolved.values['system.language']).toBe('pm-inline');
    expect(resolved.fields[0]?.sources.map((source) => `${source.surface}:${source.kind}`)).toEqual([
      'global:file',
      'global:file',
      'global:inline',
      'model:file',
      'model:inline',
      `${profileSurface}:file`,
      `${profileSurface}:inline`,
      'profile-model:file',
      'profile-model:inline',
    ]);
  });

  it('emits a registry change when a loaded override file changes', async () => {
    const watcher = new Emitter<HostFsChange>();
    ({ services } = createRegistry(fileSystem({
      [`${HOME}/watched.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "watched"\n',
    }), watcher.event));
    const registry = services.get(IPromptFieldRegistry);
    await registry.resolve({
      global: { surface: 'global', overrides: { files: ['watched.toml'] } },
    });
    const changes: Array<{ readonly ref?: string }> = [];
    registry.onDidChange((change) => changes.push(change));
    watcher.fire({ path: `${HOME}/watched.toml`, action: 'modified', kind: 'file' });
    expect(changes).toEqual([{ ref: 'watched.toml' }]);
    watcher.dispose();
  });

  it('fails closed for missing files, duplicate keys, bad TOML, wrong schema versions, and realpath escape', async () => {
    const files = {
      [`${HOME}/duplicate.toml`]: 'schema_version = 1\n[fields]\n"system.language" = "a"\n"system.language" = "b"\n',
      [`${HOME}/bad.toml`]: 'schema_version = 1\n[fields\n',
      [`${HOME}/version.toml`]: 'schema_version = 2\n[fields]\n"system.language" = "a"\n',
      '/outside/escape.toml': 'schema_version = 1\n[fields]\n"system.language" = "a"\n',
    };
    const fs = fileSystem(files, { [`${HOME}/escape.toml`]: '/outside/escape.toml' });
    await expect(readPromptOverrideFile(fs, HOME, 'missing.toml', 'posix')).rejects.toThrow(/could not be read/);
    await expect(readPromptOverrideFile(fs, HOME, 'duplicate.toml', 'posix')).rejects.toThrow(/TOML is invalid/);
    await expect(readPromptOverrideFile(fs, HOME, 'bad.toml', 'posix')).rejects.toThrow(/TOML is invalid/);
    await expect(readPromptOverrideFile(fs, HOME, 'version.toml', 'posix')).rejects.toThrow(/document is invalid/);
    await expect(readPromptOverrideFile(fs, HOME, 'escape.toml', 'posix')).rejects.toThrow(/escapes/);
    await expect(readPromptOverrideFile(fs, HOME, '../escape.toml', 'posix')).rejects.toThrow(/path is invalid/);
  });

  it('wires global and model prompt override config surfaces', () => {
    expect(PromptConfigSchema.parse({
      overrides: { files: ['global.toml'], fields: { 'system.language': 'global' } },
    }).overrides).toBeDefined();
    const transformed = modelsFromToml({
      fast: {
        provider: 'example',
        model: 'fast',
        prompt_overrides: { files: ['model.toml'], fields: { 'system.language': 'model' } },
      },
    });
    expect(ModelsSectionSchema.parse(transformed)['fast']?.promptOverrides).toEqual({
      files: ['model.toml'],
      fields: { 'system.language': 'model' },
    });
    expect(modelsToToml(ModelsSectionSchema.parse(transformed), {})).toMatchObject({
      fast: {
        prompt_overrides: {
          files: ['model.toml'],
          fields: { 'system.language': 'model' },
        },
      },
    });
  });
});
