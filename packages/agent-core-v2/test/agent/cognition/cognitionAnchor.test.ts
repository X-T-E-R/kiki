import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentCognitionAnchorService } from '#/agent/cognition/cognitionAnchor';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentProfileService } from '#/agent/profile/profile';
import { CognitionConfigSchema } from '#/app/kosongConfig/configSection';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { createUserMessage } from '#/kosong/contract/message';
import type { CognitionConfig, ModelRecord } from '#/kosong/model/model';

import {
  createTestAgent,
  homeDirServices,
  type TestAgentContext,
} from '../../harness';

const MOCK_MODEL = 'mock-model';
const ANCHOR_TEXT = 'PLAN FIRST THEN ACT';
const OVERLAY_TEXT = 'FLASH OVERLAY';
const EXPLICIT_PROMPT = 'explicit-override';
const FIRST_TURN = 0;

describe('cognition first-turn anchor', () => {
  let ctx: TestAgentContext | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-cognition-anchor-'));
    await mkdir(join(homeDir, 'cognition'));
    await writeFile(join(homeDir, 'cognition/anchor.md'), `${ANCHOR_TEXT}\n`);
    await writeFile(join(homeDir, 'cognition/overlay.md'), `${OVERLAY_TEXT}\n`);
  });

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined);
  });

  async function createBoundAgent(
    cognition?: CognitionConfig,
    extraModels?: Record<string, ModelRecord>,
  ): Promise<{
    readonly agent: TestAgentContext;
    readonly requester: IAgentLLMRequesterService;
    readonly profile: IAgentProfileService;
    readonly fullPrompt: string;
  }> {
    const agent = createTestAgent(homeDirServices(homeDir));
    ctx = agent;
    const current = agent.kimiConfig.models?.[MOCK_MODEL];
    expect(current).toBeDefined();
    agent.kimiConfig = {
      ...agent.kimiConfig,
      models: {
        ...agent.kimiConfig.models,
        [MOCK_MODEL]:
          cognition === undefined ? current! : { ...current!, cognition },
        ...extraModels,
      },
    };
    expect(agent.get(IAgentCognitionAnchorService)).toBeDefined();
    const profile = agent.get(IAgentProfileService);
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: MOCK_MODEL });
    const fullPrompt = profile.getSystemPrompt();
    return {
      agent,
      requester: agent.get(IAgentLLMRequesterService),
      profile,
      fullPrompt,
    };
  }

  async function requestTurn(
    requester: IAgentLLMRequesterService,
    agent: TestAgentContext,
    turnId: number,
    step: number,
    overrides: { readonly systemPrompt?: string } = {},
  ): Promise<string> {
    agent.mockNextResponse({ type: 'text', text: `turn-${String(turnId)}-step-${String(step)}` });
    await requester.request({
      messages: [createUserMessage('hello')],
      source: { type: 'turn', turnId, step },
      ...overrides,
    });
    const prompt = agent.llmCalls.at(-1)?.systemPrompt;
    expect(prompt).toBeDefined();
    return prompt!;
  }

  it('defaults to anchoring only the opening step of the opening turn', async () => {
    const { agent, requester, profile, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
    });
    expect(fullPrompt).toContain(OVERLAY_TEXT);
    expect(fullPrompt).not.toBe(ANCHOR_TEXT);

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN, 2)).toBe(fullPrompt);
    expect(profile.getSystemPrompt()).toBe(fullPrompt);
  });

  it('does not carry ${delegation_context} injection into the anchor window', async () => {
    await writeFile(
      join(homeDir, 'cognition/anchor.md'),
      'ANCHOR BODY ${delegation_context}\n',
    );
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
    });
    expect(fullPrompt).not.toContain('${delegation_context}');
    const anchored = await requestTurn(requester, agent, FIRST_TURN, 1);
    expect(anchored).toBe('ANCHOR BODY ${delegation_context}');
    expect(anchored).not.toContain(OVERLAY_TEXT);
  });

  it('does not carry ${profile_prompt} overlay substitution into the anchor window', async () => {
    await writeFile(
      join(homeDir, 'cognition/overlay.md'),
      `overlay around \${profile_prompt}\n`,
    );
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      overlayMode: 'wrap',
      anchor: 'cognition/anchor.md',
    });
    expect(fullPrompt).toContain('overlay around');
    expect(fullPrompt).not.toContain('${profile_prompt}');
    const anchored = await requestTurn(requester, agent, FIRST_TURN, 1);
    expect(anchored).toBe(ANCHOR_TEXT);
    expect(anchored).not.toContain('overlay around');
  });

  it('keeps the first three steps of the opening turn when anchor_steps is 3', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
      anchorSteps: 3,
    });

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN, 2)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN, 3)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN, 4)).toBe(fullPrompt);
  });

  it('does not re-anchor a later turn under the default session scope', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
      anchorScope: 'session',
    });

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN + 1, 1)).toBe(fullPrompt);
  });

  it('does not anchor a resumed session whose turn clock has already advanced', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
      anchorScope: 'session',
    });

    expect(await requestTurn(requester, agent, FIRST_TURN + 4, 1)).toBe(fullPrompt);
    expect(await requestTurn(requester, agent, FIRST_TURN + 5, 1)).toBe(fullPrompt);
  });

  it('re-anchors each turn when anchor_scope is turn', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
      anchorScope: 'turn',
    });

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN, 2)).toBe(fullPrompt);
    expect(await requestTurn(requester, agent, FIRST_TURN + 1, 1)).toBe(ANCHOR_TEXT);
    expect(await requestTurn(requester, agent, FIRST_TURN + 1, 2)).toBe(fullPrompt);
  });

  it('does not apply the anchor to operation requests or an explicit systemPrompt', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
      anchor: 'cognition/anchor.md',
    });

    agent.mockNextResponse({ type: 'text', text: 'compact' });
    await requester.request({
      messages: [createUserMessage('summarize')],
      source: { type: 'operation', turnId: FIRST_TURN, requestKind: 'full_compaction' },
    });
    expect(agent.llmCalls.at(-1)?.systemPrompt).toBe(fullPrompt);

    agent.mockNextResponse({ type: 'text', text: 'explicit' });
    await requester.request({
      messages: [createUserMessage('hello')],
      systemPrompt: EXPLICIT_PROMPT,
      source: { type: 'turn', turnId: FIRST_TURN, step: 1 },
    });
    expect(agent.llmCalls.at(-1)?.systemPrompt).toBe(EXPLICIT_PROMPT);

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(ANCHOR_TEXT);
  });

  it('leaves models without an anchor slot on the ordinary profile prompt', async () => {
    const { agent, requester, fullPrompt } = await createBoundAgent({
      overlay: 'cognition/overlay.md',
    });
    expect(fullPrompt).toContain(OVERLAY_TEXT);

    expect(await requestTurn(requester, agent, FIRST_TURN, 1)).toBe(fullPrompt);
    expect(await requestTurn(requester, agent, FIRST_TURN, 2)).toBe(fullPrompt);
  });

  it('rejects non-positive and non-integer anchor_steps at the config schema', () => {
    expect(CognitionConfigSchema.safeParse({ anchorSteps: 1 }).success).toBe(true);
    expect(CognitionConfigSchema.safeParse({ anchorSteps: 3 }).success).toBe(true);
    expect(CognitionConfigSchema.safeParse({ anchorSteps: 0 }).success).toBe(false);
    expect(CognitionConfigSchema.safeParse({ anchorSteps: -1 }).success).toBe(false);
    expect(CognitionConfigSchema.safeParse({ anchorSteps: 1.5 }).success).toBe(false);
  });
});
