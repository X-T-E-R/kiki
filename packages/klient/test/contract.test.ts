/**
 * Scenario: runtime validation at Klient wire-contract boundaries.
 *
 * Exercises the session-creation and plugin-manifest schemas directly with no
 * external collaborators. Run with `pnpm --filter @kiki/klient exec
 * vitest run test/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { pluginManifestSchema } from '../src/contract/global/plugins.js';
import { mcpServerAuthFlowHandleSchema } from '../src/contract/global/mcpManagement.js';
import { createSessionOptionsSchema } from '../src/contract/session/lifecycle.js';
import { promptPayloadSchema } from '../src/contract/agent/schemas.js';
import { agentEvents } from '../src/contract/agent/events.js';
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
});

describe('prompt lifecycle events', () => {
  it.each([
    'prompt.submitted',
    'prompt.queued',
    'prompt.started',
    'prompt.replaced',
    'prompt.moved',
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
