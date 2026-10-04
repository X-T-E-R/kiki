import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { expect, it } from 'vitest';

import { checkPromptFiles } from '#/agent/profile/promptFileChecks';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { createTestAgent, homeDirServices } from '../../harness';

it('checks all prompt file branches and discarded role-model sources without leaking file content', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kiki-prompt-file-check-'));
  const agent = createTestAgent(homeDirServices(homeDir));
  try {
    await writeFile(join(homeDir, 'valid.toml'), 'schema_version = 1\n[fields]\n"system.shared" = "PRIVATE FILE CONTENT"\n');
    await writeFile(join(homeDir, 'invalid.toml'), 'schema_version = 2\n[fields]\n"system.shared" = "invalid"\n');
    const original = { source: 'profile' as const, entries: [{ alias: 'other-model', promptOverrides: { files: ['invalid.toml'] } }] };
    const checks = await checkPromptFiles({
      fs: agent.get(IHostFileSystem), homeDir, pathClass: 'win32', modelAlias: 'current',
      global: { files: ['valid.toml'], main: { files: ['missing-global.toml'] } },
      model: { provider: 'fixture', model: 'current', maxContextSize: 1000, promptOverrides: { independent: { files: ['missing-model.toml'] } } },
      profile: { promptOverrides: { main: { files: ['missing-profile.toml'] } }, modelPromptBase: [original], modelPromptLayers: [{ source: 'lease', entries: [{ alias: 'current', promptOverrides: { files: ['valid.toml'] } }] }] },
    });
    expect(checks).toMatchObject([
      { surface: 'global', branch: 'common', path: 'valid.toml', status: 'ok' },
      { surface: 'global', branch: 'main', status: 'error' },
      { surface: 'model', branch: 'independent', status: 'error', model_alias: 'current' },
      { surface: 'profile', branch: 'main', status: 'error' },
      { surface: 'profile-model', path: 'invalid.toml', status: 'error', model_alias: 'other-model' },
      { surface: 'caller-lease-model', status: 'ok' },
    ]);
    expect(JSON.stringify(checks)).not.toContain('PRIVATE FILE CONTENT');
  } finally {
    await agent.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
