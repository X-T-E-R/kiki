/**
 * Scenario: per-model cognition overlay is appended at profile bind without
 * changing route or profile identity.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/profile/cognition-binding.test.ts`
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { CognitionConfig, ModelRecord } from '#/kosong/model/model';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ProfileErrors } from '#/agent/profile/errors';

import {
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';
const OTHER_MODEL = 'other-model';

describe('per-model cognition overlay', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-cognition-bind-'));
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/overlay.md'), 'FLASH OVERLAY');
    await writeFile(join(homeDir, 'cognition/steering.md'), 'FLASH STEERING');
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function createBoundAgent(cognition?: CognitionConfig, extraModels?: Record<string, ModelRecord>): TestAgentContext {
    ctx = createTestAgent(homeDirServices(homeDir));
    const current = ctx.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]:
          cognition === undefined
            ? current!
            : { ...current!, cognition },
        ...extraModels,
      },
    };
    return ctx;
  }

  it('appends overlay when the bound model declares it', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
    expect(profile.getSystemPrompt()).toMatch(/FLASH OVERLAY\s*$/);
  });

  it('prepends overlay when overlay_mode is prepend', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'prepend' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toMatch(/^FLASH OVERLAY\n\n/);
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('wraps overlay around the profile when overlay_mode is wrap', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'wrap' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toMatch(/^FLASH OVERLAY\n\n/);
    expect(prompt).toContain('End of assignment');
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('replaces the opening identity when overlay_mode is persona', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'persona' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const prompt = profile.getSystemPrompt();
    expect(prompt).toMatch(/^FLASH OVERLAY\n\n/);
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });

  it('replaces the whole prompt when overlay_mode is replace', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md', overlayMode: 'replace' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).toBe('FLASH OVERLAY');
    expect(profile.data().profileName).toBe(DEFAULT_AGENT_PROFILE_NAME);
  });


  it('does not rewrite a model that has no cognition block', async () => {
    const agent = createBoundAgent();
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
  });

  it('keeps the explore profile identity when overlaying Flash', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/overlay.md' });
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: 'explore', model: MOCK_MODEL });
    expect(profile.data().profileName).toBe('explore');
    expect(profile.data().routeId).toBeUndefined();
    expect(profile.getSystemPrompt()).toContain('FLASH OVERLAY');
  });

  it('fails closed when overlay is declared but the file is missing', async () => {
    const agent = createBoundAgent({ overlay: 'cognition/missing.md' });
    const profile = agent.get(IAgentProfileService);
    await expect(
      profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL }),
    ).rejects.toMatchObject({
      code: ProfileErrors.codes.COGNITION_FILE_MISSING,
    });
  });

  it('fails closed when steering is declared but the file is missing', async () => {
    const agent = createBoundAgent({ steering: 'cognition/missing.md' });
    const profile = agent.get(IAgentProfileService);
    await expect(
      profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL }),
    ).rejects.toMatchObject({
      code: ProfileErrors.codes.COGNITION_FILE_MISSING,
    });
  });

  it('does not overlay a different model in the same catalog', async () => {
    const agent = createBoundAgent(
      { overlay: 'cognition/overlay.md' },
      {
        [OTHER_MODEL]: {
          provider: 'test-provider',
          model: OTHER_MODEL,
          maxContextSize: 1_000_000,
        },
      },
    );
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: OTHER_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('FLASH OVERLAY');
  });
});
