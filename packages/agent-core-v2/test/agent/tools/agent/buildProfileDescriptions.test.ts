/**
 * Scenario: Agent tool profile-description rendering — advisory
 * `recommendedModels` lines, catalog filtering, and placement relative to
 * binding / Tools lines.
 * There is no existing Agent-tool `description` getter suite; this covers the
 * exported `buildProfileDescriptions` helper that that getter uses.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/tools/agent/buildProfileDescriptions.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { buildProfileDescriptions } from '#/agent/tools/agent/agentTool';
import {
  normalizeAgentProfile,
  type AgentProfile,
  type AgentRecommendedModel,
} from '#/app/agentProfileCatalog/agentProfileCatalog';

const RECOMMENDATIONS: readonly AgentRecommendedModel[] = [
  {
    alias: 'axon-message/grok-4.6',
    when: 'Scope and acceptance checks are already named.',
    thinkingEffort: 'high',
  },
  {
    alias: 'axon-message/deepseek-v4-pro-0813',
    when: 'Ordinary coding where DeepSeek Pro can finish.',
  },
];

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return normalizeAgentProfile({
    name: 'implementer',
    description: 'Does the implementation slice',
    whenToUse: 'When the scope is named',
    modelAlias: 'gpt-5.6-sol',
    thinkingEffort: 'high',
    recommendedModels: RECOMMENDATIONS,
    systemPrompt: () => '',
    ...overrides,
  });
}

function render(target: AgentProfile, available: readonly string[]): string {
  const allowed = new Set(available);
  return buildProfileDescriptions(
    [target],
    [],
    () => true,
    true,
    undefined,
    (alias) => allowed.has(alias),
  );
}

describe('buildProfileDescriptions recommended models', () => {
  it('renders alternative models after binding lines and before Tools', () => {
    const text = render(profile(), [
      'axon-message/grok-4.6',
      'axon-message/deepseek-v4-pro-0813',
    ]);

    expect(text).toBe(
      [
        '- implementer: Does the implementation slice When the scope is named',
        '  Model alias: gpt-5.6-sol',
        '  Thinking effort: high',
        '  Alternative models: axon-message/grok-4.6 (thinking_effort=high) — Scope and acceptance checks are already named.; axon-message/deepseek-v4-pro-0813 — Ordinary coding where DeepSeek Pro can finish.',
        '  Tools: all',
      ].join('\n'),
    );
  });

  it('omits an entry whose alias is unavailable in the catalog', () => {
    const text = render(profile(), ['axon-message/deepseek-v4-pro-0813']);

    expect(text).toContain(
      '  Alternative models: axon-message/deepseek-v4-pro-0813 — Ordinary coding where DeepSeek Pro can finish.',
    );
    expect(text).not.toContain('axon-message/grok-4.6');
  });

  it('omits the alternative-models line when every entry is unavailable', () => {
    const text = render(profile(), []);

    expect(text).toBe(
      [
        '- implementer: Does the implementation slice When the scope is named',
        '  Model alias: gpt-5.6-sol',
        '  Thinking effort: high',
        '  Tools: all',
      ].join('\n'),
    );
    expect(text).not.toContain('Alternative models');
  });

  it('renders an allowed-models line after thinking effort when an allowlist is present', () => {
    const text = render(
      profile({ allowedModels: ['fast-model', 'k3-review'] }),
      ['axon-message/grok-4.6', 'axon-message/deepseek-v4-pro-0813'],
    );

    expect(text).toBe(
      [
        '- implementer: Does the implementation slice When the scope is named',
        '  Model alias: gpt-5.6-sol',
        '  Thinking effort: high',
        '  Allowed models: fast-model, k3-review',
        '  Alternative models: axon-message/grok-4.6 (thinking_effort=high) — Scope and acceptance checks are already named.; axon-message/deepseek-v4-pro-0813 — Ordinary coding where DeepSeek Pro can finish.',
        '  Tools: all',
      ].join('\n'),
    );
  });

  it('omits the allowed-models line when there is no allowlist', () => {
    const text = render(profile({ allowedModels: undefined }), [
      'axon-message/grok-4.6',
      'axon-message/deepseek-v4-pro-0813',
    ]);

    expect(text).not.toContain('Allowed models');
  });

  it('omits the allowed-models line when the allowlist is empty', () => {
    const text = render(profile({ allowedModels: [] }), []);

    expect(text).not.toContain('Allowed models');
  });
});
