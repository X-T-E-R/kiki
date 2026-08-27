/**
 * Scenario: `model_steering` injects near-field guidance on every new turn.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/features/modelSteering/modelSteering.test.ts`
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentModelSteeringService } from '#/features/modelSteering/modelSteering';
import '#/features/modelSteering/modelSteeringFeature';

import {
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';
import { runWillBeginStepHooks } from '../../agent/loop/stubs';

const MOCK_MODEL = 'mock-model';

function steeringMessages(context: IAgentContextMemoryService): readonly ContextMessage[] {
  return context.get().filter((message) => {
    return message.origin?.kind === 'injection' && message.origin.variant === 'model_steering';
  });
}

describe('AgentModelSteeringService', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-cognition-steer-'));
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/steering.md'), 'CLASSIFY THEN ACT');
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
  });

  it('injects steering on each new turn and skips intra-turn steps', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const current = ctx.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    ctx.kimiConfig = {
      ...ctx.kimiConfig,
      models: {
        ...ctx.kimiConfig.models,
        [MOCK_MODEL]: { ...current!, cognition: { steering: 'cognition/steering.md' } },
      },
    };
    expect(ctx.get(IAgentModelSteeringService)).toBeDefined();
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    expect(profile.getSystemPrompt()).not.toContain('CLASSIFY THEN ACT');

    const loop = ctx.get(IAgentLoopService);
    const memory = ctx.get(IAgentContextMemoryService);

    await runWillBeginStepHooks(loop, true);
    expect(steeringMessages(memory)).toHaveLength(1);
    expect(steeringMessages(memory)[0]?.role).toBe('user');
    expect(steeringMessages(memory)[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'CLASSIFY THEN ACT',
    });

    await runWillBeginStepHooks(loop, false);
    expect(steeringMessages(memory)).toHaveLength(1);

    await runWillBeginStepHooks(loop, true);
    expect(steeringMessages(memory)).toHaveLength(2);
  });

  it('does not inject when the bound model has no steering slot', async () => {
    ctx = createTestAgent(homeDirServices(homeDir));
    const profile = ctx.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    await runWillBeginStepHooks(ctx.get(IAgentLoopService), true);
    expect(steeringMessages(ctx.get(IAgentContextMemoryService))).toHaveLength(0);
  });
});
