import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, type Event } from '#/index';
import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];
afterEach(async () => { await removeTempDirs(tempDirs); });

describe('Session automatic compaction API', () => {
  it('reads, persists and emits the per-model threshold through the in-process client', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kiki-sdk-auto-compact-home-');
    const workDir = await makeTempDir(tempDirs, 'kiki-sdk-auto-compact-work-');
    await writeFile(join(homeDir, 'config.toml'), [
      'default_model = "test-model"',
      '[providers.local]',
      'type = "openai"',
      'base_url = "https://example.test/v1"',
      'api_key = "sk-test"',
      '[models.test-model]',
      'provider = "local"',
      'model = "test-model"',
      'max_context_size = 200000',
      '',
    ].join('\n'));
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    try {
      const session = await harness.createSession({ id: 'ses_auto_compact_runtime', workDir });
      expect(await session.getAutoCompact()).toMatchObject({ source: 'legacy', tokens: 150_000 });
      const events: Event[] = [];
      const stop = session.onEvent((event) => { events.push(event); });
      try {
        const updated = await session.setAutoCompact({ tokens: 120_000 });
        expect(updated.effective).toMatchObject({ source: 'session', tokens: 120_000 });
        expect(events).toContainEqual(expect.objectContaining({
          type: 'agent.status.updated', autoCompactTokens: 120_000, autoCompactSource: 'session',
        }));
        expect((await session.setAutoCompact({ tokens: 120_000, save: 'model' }))).toMatchObject({
          overrideCleared: true, effective: { source: 'model', tokens: 120_000 },
        });
        await expect(session.setAutoCompact({ tokens: null, save: 'global' })).rejects.toThrow();
        expect(await session.getAutoCompact()).toMatchObject({ source: 'model', tokens: 120_000 });
      } finally {
        stop();
      }
    } finally {
      await harness.close();
    }
  });
});
