import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ISettingsProfileResources } from '#/app/settingsTransfer/profileResources';
import { SettingsProfileResources } from '#/os/backends/node-fs/settingsProfileResources';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { windowsSymlinksUnavailable } from '../../../_base/utils/symlink';

const profileText = (name: string): string => `---
name: ${name}
description: ${name} profile
---

You are ${name}.
`;

const routeText = (id: string, profile: string): string => `---
id: ${id}
profile: ${profile}
description: ${id} route
prompt_mode: prepend
---

Use the route.
`;

const systemText = `---
name: default
description: user system
system_prompt_mode: append
---

Use the user system instructions.
`;

const promptOverrideText = `schema_version = 1

[fields]
"system.language" = "concise"
`;

let root: string;
let homeDir: string;
let profilesHomeDir: string;
let outsideDir: string;
let disposables: DisposableStore;
let ix: TestInstantiationService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kiki-settings-profile-resources-'));
  const makeDirectory = async (name: string): Promise<string> => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return realpath(path);
  };
  [homeDir, profilesHomeDir, outsideDir] = await Promise.all([
    makeDirectory('home'),
    makeDirectory('profiles'),
    makeDirectory('outside'),
  ]);
  const bootstrap = {
    _serviceBrand: undefined,
    platform: process.platform,
    homeDir,
    userAgentProfileHomeDir: profilesHomeDir,
  } as unknown as IBootstrapService;
  const defaultProfile = {
    name: 'default',
    description: 'builtin default',
    main: true,
    tools: [],
    disallowedTools: [],
    renderSystemPrompt: () => ({ text: 'builtin prompt' }),
  } as unknown as AgentProfile;
  disposables = new DisposableStore();
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.defineInstance(IBootstrapService, bootstrap);
      reg.defineInstance(IHostFileSystem, new HostFileSystem());
      reg.defineInstance(IBuiltinAgentProfileLoader, {
        _serviceBrand: undefined,
        get: () => defaultProfile,
        getDefault: () => defaultProfile,
        list: () => [defaultProfile],
      });
      reg.define(ISettingsProfileResources, SettingsProfileResources);
    },
  });
});

afterEach(async () => {
  await disposables.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe('SettingsProfileResources', () => {
  it('lists user profiles, routes, SYSTEM.md, and referenced home prompt overrides only', async () => {
    await mkdir(join(profilesHomeDir, 'agents', 'nested'), { recursive: true });
    await mkdir(join(profilesHomeDir, 'agents', '.routes', 'worker'), { recursive: true });
    await mkdir(join(profilesHomeDir, 'agents', 'builtin'), { recursive: true });
    await mkdir(join(homeDir, 'prompts'), { recursive: true });
    await mkdir(join(homeDir, 'agents'), { recursive: true });
    await writeFile(join(profilesHomeDir, 'agents', 'lead.md'), `---
name: lead
description: lead profile
prompt_overrides:
  files: [prompts/shared.toml]
---

You are lead.
`);
    await writeFile(join(profilesHomeDir, 'agents', 'nested', 'helper.md'), profileText('helper'));
    await writeFile(join(profilesHomeDir, 'agents', '.routes', 'worker', 'review.md'), routeText('worker.review', 'worker'));
    await writeFile(join(profilesHomeDir, 'agents', 'builtin', 'managed.md'), profileText('managed'));
    await writeFile(join(profilesHomeDir, 'agents', 'invalid.md'), '---\nname: invalid\nunknown: true\n---\n\nbody\n');
    await writeFile(join(profilesHomeDir, 'SYSTEM.md'), systemText);
    await writeFile(join(homeDir, 'prompts', 'shared.toml'), promptOverrideText);
    await writeFile(join(homeDir, 'agents', 'generic.md'), profileText('generic'));

    const resources = ix.get(ISettingsProfileResources);

    await expect(resources.list()).resolves.toEqual([
      { key: 'SYSTEM.md', text: systemText },
      { key: 'agents/.routes/worker/review.md', text: routeText('worker.review', 'worker') },
      { key: 'agents/lead.md', text: expect.any(String) },
      { key: 'agents/nested/helper.md', text: profileText('helper') },
      { key: 'prompts/shared.toml', text: promptOverrideText },
    ]);
  });

  it('fails closed when a valid profile references an unavailable prompt override', async () => {
    await mkdir(join(profilesHomeDir, 'agents'), { recursive: true });
    const resources = ix.get(ISettingsProfileResources);
    const profilePath = join(profilesHomeDir, 'agents', 'lead.md');
    await writeFile(profilePath, `---
name: lead
description: lead profile
prompt_overrides:
  files: [prompts/missing.toml]
---

You are lead.
`);

    await expect(resources.list()).rejects.toMatchObject({
      name: 'SettingsProfileResourceError',
      code: 'settings_profile_resource.invalid',
    });
    await expect(resources.list()).rejects.not.toThrow(/missing\.toml/iu);

    await writeFile(profilePath, `---
name: lead
description: lead profile
prompt_overrides:
  files: [tools/secret.toml]
---

You are lead.
`);
    await expect(resources.list()).rejects.not.toThrow(/secret\.toml/iu);
  });

  it('validates raw profile, SYSTEM.md, route, and prompt override resources', async () => {
    const resources = ix.get(ISettingsProfileResources);

    expect(() => { resources.validate({ key: 'agents/worker.md', text: profileText('worker') }); }).not.toThrow();
    expect(() => { resources.validate({ key: 'SYSTEM.md', text: systemText }); }).not.toThrow();
    expect(() => { resources.validate({ key: 'agents/.routes/worker/review.md', text: routeText('worker.review', 'worker') }); }).not.toThrow();
    expect(() => { resources.validate({ key: 'prompts/shared.toml', text: promptOverrideText }); }).not.toThrow();
    const profileWithRefs = `---
name: lead
description: lead profile
prompt_overrides:
  files: [prompts/common.toml]
model_profiles:
  - alias: fast
    prompt_mode: append
    prompt: Fast
    prompt_overrides:
      files: [prompts/fast.toml]
---

You are lead.
`;
    expect(resources.references({ key: 'agents/lead.md', text: profileWithRefs })).toEqual([
      'prompts/common.toml',
      'prompts/fast.toml',
    ]);
    expect(resources.references({ key: 'SYSTEM.md', text: systemText })).toEqual([]);
    expect(resources.references({ key: 'agents/.routes/worker/review.md', text: routeText('worker.review', 'worker') })).toEqual([]);
    expect(resources.references({ key: 'prompts/shared.toml', text: promptOverrideText })).toEqual([]);
    expect(() => { resources.validate({ key: 'agents/bad.md', text: '---\nname: bad\nunknown: true\n---\n\nbody\n' }); }).toThrow();
    expect(() => { resources.validate({ key: 'prompts/shared.toml', text: 'schema_version = 2\n' }); }).toThrow();
  });

  it('rejects absolute and traversal keys and enforces resource size limits', async () => {
    const resources = ix.get(ISettingsProfileResources);

    expect(() => { resources.validate({ key: '../outside.md', text: profileText('outside') }); }).toThrow(/relative path|traversal/iu);
    expect(() => { resources.validate({ key: 'C:\\outside.md', text: profileText('outside') }); }).toThrow(/relative path/iu);
    expect(() => { resources.validate({ key: 'agents\\worker.md', text: profileText('worker') }); }).toThrow(/forward slashes/iu);
    expect(() => { resources.validate({ key: 'agents/../outside.md', text: profileText('outside') }); }).toThrow(/traversal/iu);
    for (const key of ['credentials./secret.toml', 'credentials /secret.toml', 'agents/builtin./new.md', 'prompts/shared.toml:stream.toml', 'C:shared.toml', 'prompts/NUL.toml']) {
      expect(() => { resources.validate({ key, text: promptOverrideText }); }).toThrow(/portable path/iu);
      await expect(resources.read(key)).rejects.toThrow(/portable path/iu);
      await expect(resources.write({ key, text: promptOverrideText })).rejects.toThrow(/portable path/iu);
    }
    expect(() => { resources.validate({ key: 'prompts/large.toml', text: 'x'.repeat(1_048_577) }); }).toThrow(/size limit/iu);
    expect(() => { resources.validate({ key: 'tools/secret.toml', text: promptOverrideText }); }).toThrow(/not transferable/iu);
    expect(() => { resources.validate({ key: 'config.toml', text: promptOverrideText }); }).toThrow(/not transferable/iu);
    await expect(resources.read('../outside.md')).rejects.toThrow(/relative path|traversal/iu);
    await expect(resources.read('agents\\worker.md')).rejects.toThrow(/forward slashes/iu);
    await expect(resources.read('credentials/secret.toml')).rejects.toThrow(/not transferable/iu);
  });

  it('writes and deletes atomically under the selected profile and home roots', async () => {
    const resources = ix.get(ISettingsProfileResources);
    const profile = { key: 'agents/new/nested.md', text: profileText('nested') };
    const system = { key: 'SYSTEM.md', text: systemText };
    const prompt = { key: 'prompts/new.toml', text: promptOverrideText };

    await resources.write(profile);
    await resources.write(system);
    await resources.write(prompt);

    await expect(resources.read(profile.key)).resolves.toBe(profile.text);
    await expect(resources.read(system.key)).resolves.toBe(system.text);
    await expect(resources.read(prompt.key)).resolves.toBe(prompt.text);
    await expect(readFile(join(profilesHomeDir, profile.key), 'utf8')).resolves.toBe(profile.text);
    await expect(readFile(join(homeDir, prompt.key), 'utf8')).resolves.toBe(prompt.text);

    await resources.delete(profile.key);
    await resources.delete(system.key);
    await resources.delete(prompt.key);
    await expect(resources.read(profile.key)).resolves.toBeUndefined();
    await expect(resources.read(system.key)).resolves.toBeUndefined();
    await expect(resources.read(prompt.key)).resolves.toBeUndefined();
  });

  it.skipIf(windowsSymlinksUnavailable)('does not enumerate or follow symlinked profile paths', async () => {
    await mkdir(join(profilesHomeDir, 'agents'), { recursive: true });
    await writeFile(join(outsideDir, 'outside.md'), profileText('outside'));
    await symlink(join(outsideDir, 'outside.md'), join(profilesHomeDir, 'agents', 'escape.md'));
    await symlink(outsideDir, join(profilesHomeDir, 'agents', 'linked'));
    const resources = ix.get(ISettingsProfileResources);

    await expect(resources.list()).resolves.toEqual([]);
    await expect(resources.read('agents/escape.md')).rejects.toThrow(/symbolic link/iu);
    await expect(resources.read('agents/linked/outside.md')).rejects.toThrow(/symbolic link/iu);
    await expect(resources.write({ key: 'agents/escape.md', text: profileText('replacement') })).rejects.toThrow(/symbolic link/iu);
    await expect(readFile(join(outsideDir, 'outside.md'), 'utf8')).resolves.toBe(profileText('outside'));
  });
});
