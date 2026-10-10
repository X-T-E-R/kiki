/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @kiki/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { CapabilityStep, CapabilityStatus, CapabilityStepReason } from '@kiki/agent-core-v2/app/capability/types';
import { capabilityStepSchema, capabilityStatusSchema } from '../src/contract/global/capabilities.js';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { oAuthFlowSnapshotSchema, oAuthMethodStatusSchema } from '../src/contract/global/auth.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { activateSkillPayloadSchema, promptPayloadSchema } from '../src/contract/agent/schemas.js';
import { agentEvents } from '../src/contract/agent/events.js';
import { agentPromptContract, agentSkillContract } from '../src/contract/agent/services.js';
import { sessionCommandContract } from '../src/contract/session/commands.js';
import { agentCollaborationMessagingContract } from '../src/contract/session/agentMessage.js';
import {
  providerConfigSchema,
  requestIdentityPolicySchema as providerRequestIdentityPolicySchema,
} from '../src/contract/global/providers.js';
import {
  modelCatalogItemSchema,
  requestIdentityPolicySchema as catalogRequestIdentityPolicySchema,
} from '../src/contract/global/catalog.js';
import {
  configReplaceInputSchema,
  configReplaceSectionsInputSchema,
  configSetInputSchema,
} from '../src/contract/global/config.js';
import { modelConfigSchema } from '../src/contract/global/models.js';

import { sessionViewSubscribeInputSchema, sessionViewTranscriptPageInputSchema, sessionViewSignalSchema } from '../src/contract/session/view.js';

describe('skill activation output contract', () => {
  it('preserves accepted queue receipts with or without a launched turn', () => {
    const queued = { prompt_id: 'skill-prompt', created_at: '2026-10-10T00:00:00.000Z', state: 'queued', append_timing: 'agent_idle', revision: 0 };
    expect(agentSkillContract.activate.output.parse(queued)).toEqual(queued);
    const running = { ...queued, state: 'running', turn_id: 7 };
    expect(agentSkillContract.activate.output.parse(running)).toEqual(running);
    expect(agentSkillContract.activate.output.parse({ turn_id: 7 })).toEqual({ turn_id: 7 });
  });
});

describe('user mailbox input contract', () => {
  it('accepts complete long user text for both full and compact receipts', () => {
    const input = [{ targetAgentId: 'child', content: '文'.repeat(1_500_000), idempotencyKey: 'submission' }];
    for (const method of Object.values(agentCollaborationMessagingContract)) {
      expect(method.input.parse(input)).toEqual(input);
      expect(method.input.safeParse([{ ...input[0], content: '' }]).success).toBe(false);
    }
  });
});

describe('capability reason contract', () => {
  const status: CapabilityStatus = {
    id: 'kimi-webbridge', displayName: 'Browser connection', description: 'Browser readiness',
    supported: true, state: 'partial', steps: [], install: { running: false },
  };

  it('round-trips known, unknown, and absent reasons through step and status validation', () => {
    const reasons: CapabilityStepReason[] = ['daemon_identity_unverified', 'future_browser_reason'];
    const steps: CapabilityStep[] = [
      { id: 'daemon', state: 'missing' },
      ...reasons.map((reason): CapabilityStep => ({ id: 'daemon', state: 'missing', reason })),
    ];
    for (const step of steps) expect(capabilityStepSchema.parse(step)).toEqual(step);
    const value: CapabilityStatus = { ...status, steps };
    expect(capabilityStatusSchema.parse(value)).toEqual(value);
  });

  it('rejects non-string reasons and invalid step states without loosening adjacent fields', () => {
    for (const reason of [null, 42, true, {}]) {
      const step = { id: 'daemon', state: 'missing', reason };
      expect(capabilityStepSchema.safeParse(step).success).toBe(false);
      expect(capabilityStatusSchema.safeParse({ ...status, steps: [step] }).success).toBe(false);
    }
    expect(capabilityStepSchema.safeParse({ id: 'daemon', state: 'future_state', reason: 'future_browser_reason' }).success).toBe(false);
    expect(capabilityStatusSchema.safeParse({ ...status, state: 'future_readiness' }).success).toBe(false);
  });
});

describe('session view contract', () => {
  it('keeps durable and transcript checkpoints independent', () => {
    const parsed = sessionViewSubscribeInputSchema.parse({
      sessionCursor: { seq: 7, epoch: 'session-epoch' }, transcriptGrades: { main: 'delta' },
      transcriptSince: { main: { seq: 31, epoch: 'transcript-epoch' } },
    });
    expect(parsed.sessionCursor).toEqual({ seq: 7, epoch: 'session-epoch' });
    expect(parsed.transcriptSince).toEqual({ main: { seq: 31, epoch: 'transcript-epoch' } });
  });
  it('rejects unsafe agent ids, ambiguous paging, and negative generations', () => {
    expect(sessionViewTranscriptPageInputSchema.safeParse({ agentId: '../main' }).success).toBe(false);
    expect(sessionViewTranscriptPageInputSchema.safeParse({ agentId: 'main', beforeTurn: 't1', afterTurn: 't2' }).success).toBe(false);
    expect(sessionViewSignalSchema.safeParse({ type: 'status', status: 'open', generation: -1 }).success).toBe(false);
  });
});

type McpTimeoutField = 'startupTimeoutMs' | 'toolTimeoutMs';

const timeoutCases = [
  {
    surface: 'plugin manifests',
    parse: (field: McpTimeoutField, value: number) =>
      pluginManifestSchema.safeParse({
        name: 'example',
        mcpServers: {
          example: { transport: 'stdio', command: 'node', [field]: value },
        },
      }),
  },
].flatMap(({ surface, parse }) => [
  { surface, field: 'startupTimeoutMs' as const, parse },
  { surface, field: 'toolTimeoutMs' as const, parse },
]);

describe('MCP timeout contract validation', () => {
  it.each(timeoutCases)('accepts the maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_647).success).toBe(true);
  });

  it.each(timeoutCases)('rejects an above-maximum $field for $surface', ({ field, parse }) => {
    expect(parse(field, 2_147_483_648).success).toBe(false);
  });

  it('session creation options accept ephemeral mcpServers', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        stdioExample: { transport: 'stdio', command: 'node', args: ['server.mjs'] },
        httpExample: { transport: 'http', url: 'https://example.com/mcp', headers: { a: 'b' } },
        sseExample: { transport: 'sse', url: 'https://example.com/sse' },
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mcpServers?.['stdioExample']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    });
  });

  it('session creation options reject malformed mcpServers entries', () => {
    const parsed = createSessionOptionsSchema.safeParse({
      workDir: '/tmp/example',
      mcpServers: {
        example: { transport: 'http', url: 'not-a-url' },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('completeAuth timeoutMs accepts the setTimeout maximum and rejects above it', () => {
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_647 })
        .success,
    ).toBe(true);
    expect(
      mcpServerAuthFlowHandleSchema.safeParse({ flowId: 'flow-1', timeoutMs: 2_147_483_648 })
        .success,
    ).toBe(false);
  });
});

describe('prompt contract validation', () => {
  it('rejects an empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: '' }).success).toBe(false);
  });

  it('accepts a non-empty caller-chosen promptId', () => {
    expect(promptPayloadSchema.safeParse({ input: [], promptId: 'submission-1' }).success).toBe(true);
  });

  it('allows recover mode only for retry and keeps keep_original mode-less', () => {
    const recover = agentPromptContract.recoverModelSwitch;
    expect(recover.input.parse(['switch-1', 'retry', 'fresh'])).toEqual(['switch-1', 'retry', 'fresh']);
    expect(recover.input.parse(['switch-1', 'retry'])).toEqual(['switch-1', 'retry']);
    expect(recover.input.parse(['switch-1', 'keep_original'])).toEqual(['switch-1', 'keep_original']);
    expect(recover.input.safeParse(['switch-1', 'keep_original', 'fresh']).success).toBe(false);
  });
});

describe('skill activation contract validation', () => {
  it('preserves the model-switch dependency in the engine-side activation payload', () => {
    expect(activateSkillPayloadSchema.parse({
      name: 'review',
      args: '--fix',
      afterModelSwitch: 'switch-1',
    })).toEqual({ name: 'review', args: '--fix', afterModelSwitch: 'switch-1' });
  });

  it('rejects an empty model-switch dependency id', () => {
    expect(activateSkillPayloadSchema.safeParse({ name: 'review', afterModelSwitch: '' }).success).toBe(false);
  });
});

describe('prompt lifecycle events', () => {
  it.each([
    'prompt.submitted',
    'prompt.queued',
    'prompt.started',
    'prompt.replaced',
    'prompt.moved',
    'prompt.timing_changed',
    'prompt.steered',
    'prompt.completed',
    'prompt.aborted',
  ] as const)('declares %s on the typed agent event map', (type) => {
    expect(agentEvents[type]?.type).toBe(type);
  });

  it('parses prompt.queued instead of dropping the live frame', () => {
    expect(
      agentEvents['prompt.queued'].schema.parse({
        type: 'prompt.queued',
        promptId: 'prompt_1',
        content: [{ type: 'text', text: 'later' }],
        queueLength: 1,
      }),
    ).toMatchObject({ type: 'prompt.queued', promptId: 'prompt_1', queueLength: 1 });
  });

  it('parses deferred-append timing and revision on the queue events', () => {
    expect(
      agentEvents['prompt.submitted'].schema.parse({
        type: 'prompt.submitted',
        promptId: 'prompt_1',
        userMessageId: 'msg_1',
        status: 'queued',
        content: [{ type: 'text', text: 'later' }],
        createdAt: '2026-06-09T00:00:00.000Z',
        appendTiming: 'tasks_done',
        revision: 4,
      }),
    ).toMatchObject({ appendTiming: 'tasks_done', revision: 4 });

    expect(
      agentEvents['prompt.timing_changed'].schema.parse({
        type: 'prompt.timing_changed',
        promptId: 'prompt_1',
        appendTiming: 'subagents_done',
        revision: 5,
        changedAt: '2026-06-09T00:00:01.000Z',
      }),
    ).toMatchObject({ appendTiming: 'subagents_done', revision: 5 });
  });
});

describe('session prompt command contract', () => {
  it('exposes the edit-hold command', () => {
    const hold = sessionCommandContract.hold;
    expect(hold.method).toBe('POST');
    expect(hold.suffix).toBe('/prompts/{target}:hold');
    expect(hold.input.parse({ target: 'p1', body: { held: true } })).toEqual({ target: 'p1', body: { held: true } });
    expect(hold.output.parse({ prompt_id: 'p1', held: false })).toEqual({ prompt_id: 'p1', held: false });
  });

  it('exposes the timing command with its own body and PromptItem result', () => {
    const timing = sessionCommandContract.timing;
    expect(timing.method).toBe('POST');
    expect(timing.suffix).toBe('/prompts/{target}:timing');
    expect(timing.input.parse({ target: 'p1', body: { append_timing: 'tasks_done' } })).toEqual({
      target: 'p1',
      body: { append_timing: 'tasks_done' },
    });
    expect(
      timing.output.parse({
        prompt_id: 'p1',
        user_message_id: 'm1',
        status: 'queued',
        content: [{ type: 'text', text: 'later' }],
        created_at: '2026-06-09T00:00:00.000Z',
        append_timing: 'tasks_done',
        revision: 2,
      }),
    ).toMatchObject({ append_timing: 'tasks_done', revision: 2 });
    expect(timing.input.safeParse({ target: 'p1', body: {} }).success).toBe(false);
  });

  it('passes after_model_switch through the session submit command contract', () => {
    const submit = sessionCommandContract.submit;
    expect(submit.input.parse({
      body: { content: [{ type: 'text', text: 'continue' }], after_model_switch: 'switch-1' },
    })).toEqual({
      body: { content: [{ type: 'text', text: 'continue' }], after_model_switch: 'switch-1' },
    });
    expect(submit.input.safeParse({
      body: { content: [{ type: 'text', text: 'continue' }], after_model_switch: '' },
    }).success).toBe(false);
  });
});

describe('request identity contract validation', () => {
  it.each(['requestAttribution', 'requestOriginator'] as const)(
    'rejects removed provider field %s without changing unrelated unknown-field handling',
    (removed) => {
      expect(providerConfigSchema.safeParse({ type: 'openai', [removed]: 'old' }).success).toBe(false);
      expect(providerConfigSchema.parse({ type: 'openai', futureField: 'ignored' })).toEqual({
        type: 'openai',
      });
    },
  );

  it.each([providerRequestIdentityPolicySchema, catalogRequestIdentityPolicySchema])(
    'rejects unknown root and nested axes recursively',
    (schema) => {
      expect(schema.safeParse({ preset: 'none', future_root: true }).success).toBe(false);
      expect(
        schema.safeParse({
          preset: 'none',
          overrides: { request: { future_axis: 'value' } },
        }).success,
      ).toBe(false);
    },
  );

  it.each([providerRequestIdentityPolicySchema, catalogRequestIdentityPolicySchema])(
    'accepts kimi_code and rejects the removed kiki preset name',
    (schema) => {
      expect(schema.safeParse({ preset: 'kimi_code' }).success).toBe(true);
      expect(schema.safeParse({ preset: 'kiki' }).success).toBe(false);
    },
  );

  it.each([providerRequestIdentityPolicySchema, catalogRequestIdentityPolicySchema])(
    'accepts one override leaf and rejects recursively empty authored layers',
    (schema) => {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ overrides: {} }).success).toBe(false);
      expect(schema.safeParse({ overrides: { client: {} } }).success).toBe(false);
      const layer =
        schema === providerRequestIdentityPolicySchema
          ? { overrides: { client: { userAgent: 'host' } } }
          : { overrides: { client: { user_agent: 'host' } } };
      expect(schema.safeParse(layer).success).toBe(true);
    },
  );

  it('validates global config, provider, model, and catalog identity contracts', () => {
    const camel = { overrides: { client: { userAgent: 'host' as const } } };
    const wire = { overrides: { client: { user_agent: 'host' as const } } };
    expect(configSetInputSchema.safeParse(['requestIdentity', camel]).success).toBe(true);
    expect(configReplaceInputSchema.safeParse(['requestIdentity', undefined]).success).toBe(true);
    expect(
      configReplaceSectionsInputSchema.safeParse([{ requestIdentity: camel }]).success,
    ).toBe(true);
    expect(configSetInputSchema.safeParse(['requestIdentity', {}]).success).toBe(false);
    expect(providerConfigSchema.parse({ requestIdentity: camel })).toEqual({
      requestIdentity: camel,
    });
    expect(modelConfigSchema.parse({ requestIdentity: camel })).toEqual({
      requestIdentity: camel,
    });
    expect(
      modelCatalogItemSchema.parse({
        id: 'fast',
        provider_id: 'example',
        remote_id: 'vendor/model:v1',
        max_context_size: 1024,
        request_identity: wire,
      }),
    ).toMatchObject({ request_identity: wire });
  });
});


describe('managed account sign-in contract', () => {
  const method = { id: 'grok-build', label: 'Grok Build', provider: 'managed:grok-build', protocol: 'openai', signed_in: true, account: { state: 'unknown' }, quota: { state: 'unknown' } };

  it('accepts legacy account snapshots and explicit refresh/reconnect state without credentials', () => {
    expect(oAuthMethodStatusSchema.parse(method).connection_state).toBeUndefined();
    expect(oAuthMethodStatusSchema.parse({ ...method, connection_state: 'refresh_required', access_token: 'private-example' })).toMatchObject({ connection_state: 'refresh_required' });
    expect(JSON.stringify(oAuthMethodStatusSchema.parse({ ...method, connection_state: 'ready', refresh_token: 'private-example' }))).not.toContain('private-example');
    expect(oAuthMethodStatusSchema.safeParse({ ...method, connection_state: 'refreshing-forever' }).success).toBe(false);
  });

  it('accepts ordinary login failure independently from denial and rejects unrecognized status', () => {
    const snapshot = { flow_id: 'flow-example', provider: 'managed:grok-build', status: 'failed', verification_uri: 'https://auth.example.test/device', verification_uri_complete: 'https://auth.example.test/device', user_code: 'CODE-1234', expires_in: 300, expires_at: '2026-10-04T00:05:00.000Z', interval: 5, error_message: 'Model catalog unavailable.' };
    expect(oAuthFlowSnapshotSchema.parse(snapshot).status).toBe('failed');
    expect(oAuthFlowSnapshotSchema.safeParse({ ...snapshot, status: 'unrecognized' }).success).toBe(false);
  });
});
