import { z } from 'zod';
import { createSessionRequestSchema } from './rest/session';
import { promptSubmissionSchema, promptSubmitResultSchema } from './rest/prompt';
import { sessionSnapshotResponseSchema } from './rest/snapshot';
import { llmCompleteRequestSchema, llmCompleteResponseSchema, llmCompleteStreamEventSchema } from './rest/llmComplete';
import { interactionRespondRequestSchema, interactionRespondResultSchema, pendingUserToolSchema } from './rest/interactions';
import {
  rawContextUndoFrameSchema,
  rawEventFrameSchema,
  rawEventResetFrameSchema,
  rawGlobalEventsQuerySchema,
  rawSessionEventsQuerySchema,
  rawToolRequiresActionFrameSchema,
} from './rest/rawEvents';
import { sessionSchema } from './session';

export interface RawSubstrateOpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  readonly serverUrl?: string;
}

function toSchema(schema: z.ZodType, io: 'input' | 'output' = 'input'): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = raw;
  return sortKeys(rest) as Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function errorEnvelopeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['code', 'msg', 'data', 'request_id'],
    properties: {
      code: { type: 'integer' },
      msg: { type: 'string' },
      data: { type: 'null' },
      request_id: { type: 'string' },
      details: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'message'],
          properties: {
            path: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  };
}

function envelopeRef(refName: string): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: 'object',
        required: ['code', 'msg', 'data', 'request_id'],
        properties: {
          code: { const: 0 },
          msg: { type: 'string' },
          data: { $ref: `#/components/schemas/${refName}` },
          request_id: { type: 'string' },
        },
      },
      { $ref: '#/components/schemas/ErrorEnvelope' },
    ],
  };
}

function relaxInferredMcpTransport(createSchema: Record<string, unknown>): Record<string, unknown> {
  const props = createSchema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const mcpServers = props?.['mcp_servers'];
  const additional = mcpServers?.['additionalProperties'] as Record<string, unknown> | undefined;
  const branches = additional?.['anyOf'] ?? additional?.['oneOf'];
  if (!Array.isArray(branches)) return createSchema;
  for (const branch of branches) {
    if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) continue;
    const obj = branch as Record<string, unknown>;
    const transportConst = (obj['properties'] as Record<string, Record<string, unknown>> | undefined)?.['transport']?.['const'];
    if ((transportConst === 'stdio' || transportConst === 'http') && Array.isArray(obj['required'])) {
      obj['required'] = (obj['required'] as unknown[]).filter((field) => field !== 'transport');
    }
  }
  return createSchema;
}

function sessionStreamFrameSchema(): Record<string, unknown> {
  return {
    oneOf: [
      { $ref: '#/components/schemas/RawEventResetFrame' },
      { $ref: '#/components/schemas/RawToolRequiresActionFrame' },
      { $ref: '#/components/schemas/RawContextUndoFrame' },
      {
        allOf: [
          { $ref: '#/components/schemas/RawEventFrame' },
          {
            not: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { enum: ['reset', 'tool.requires_action', 'context.undo'] },
              },
            },
          },
        ],
      },
    ],
  };
}

function globalStreamFrameSchema(): Record<string, unknown> {
  return {
    oneOf: [
      { $ref: '#/components/schemas/RawEventResetFrame' },
      {
        allOf: [
          { $ref: '#/components/schemas/RawEventFrame' },
          {
            not: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { const: 'reset' },
              },
            },
          },
        ],
      },
    ],
  };
}

/**
 * Deterministic OpenAPI 3.1.0 document for Kiki's raw substrate surface
 * (R1 sessions/prompts, R2 stateless cursor event streams, R3 sessionless
 * governed completion, R4(c) stateless user_tool respond + snapshot).
 */
export function buildRawSubstrateOpenApi(options: RawSubstrateOpenApiOptions = {}): Record<string, unknown> {
  const title = options.title ?? 'Kiki Raw Substrate API';
  const version = options.version ?? '1.0.0';
  const serverUrl = options.serverUrl ?? 'http://127.0.0.1:58627';

  return {
    openapi: '3.1.0',
    info: {
      title,
      version,
      description: 'Stateless raw substrate primitives exposed by kiki-server (R1-R5).',
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Local owner token or scoped ksa_ session-access token.',
        },
      },
      schemas: {
        ErrorEnvelope: errorEnvelopeSchema(),
        CreateSessionRequest: relaxInferredMcpTransport(toSchema(createSessionRequestSchema, 'input')),
        Session: toSchema(sessionSchema, 'output'),
        PromptSubmission: toSchema(promptSubmissionSchema, 'input'),
        PromptSubmitResult: toSchema(promptSubmitResultSchema, 'output'),
        SessionSnapshotResponse: toSchema(sessionSnapshotResponseSchema, 'output'),
        LlmCompleteRequest: toSchema(llmCompleteRequestSchema, 'input'),
        LlmCompleteResponse: toSchema(llmCompleteResponseSchema, 'output'),
        LlmCompleteStreamEvent: toSchema(llmCompleteStreamEventSchema, 'output'),
        PendingUserTool: toSchema(pendingUserToolSchema, 'output'),
        InteractionRespondRequest: toSchema(interactionRespondRequestSchema, 'input'),
        InteractionRespondResult: toSchema(interactionRespondResultSchema, 'output'),
        RawSessionEventsQuery: toSchema(rawSessionEventsQuerySchema, 'input'),
        RawGlobalEventsQuery: toSchema(rawGlobalEventsQuerySchema, 'input'),
        RawEventFrame: toSchema(rawEventFrameSchema, 'output'),
        RawEventResetFrame: toSchema(rawEventResetFrameSchema, 'output'),
        RawToolRequiresActionFrame: toSchema(rawToolRequiresActionFrameSchema, 'output'),
        RawContextUndoFrame: toSchema(rawContextUndoFrameSchema, 'output'),
      },
    },
    paths: {
      '/api/sessions': {
        post: {
          operationId: 'createSession',
          tags: ['R1'],
          summary: 'Create a session with optional session-scoped mcp_servers and declarative user_tools',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateSessionRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Created session envelope',
              content: {
                'application/json': {
                  schema: envelopeRef('Session'),
                },
              },
            },
          },
        },
      },
      '/api/sessions/{session_id}/prompts': {
        post: {
          operationId: 'submitPrompt',
          tags: ['R1'],
          summary: 'Submit a prompt with optional wait, output_schema, and include_thinking',
          parameters: [
            { name: 'session_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PromptSubmission' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Prompt submission receipt and optional settled turn_result',
              content: {
                'application/json': {
                  schema: envelopeRef('PromptSubmitResult'),
                },
              },
            },
          },
        },
      },
      '/api/sessions/{session_id}/snapshot': {
        get: {
          operationId: 'getSessionSnapshot',
          tags: ['R2', 'R4c'],
          summary: 'Atomic session snapshot with as_of_seq watermark, epoch, and pending_user_tools',
          parameters: [
            { name: 'session_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'Session snapshot envelope',
              content: {
                'application/json': {
                  schema: envelopeRef('SessionSnapshotResponse'),
                },
              },
            },
          },
        },
      },
      '/api/sessions/{session_id}/events': {
        get: {
          operationId: 'streamSessionEvents',
          tags: ['R2', 'R5'],
          summary: 'Stateless cursor event stream (SSE or NDJSON) for one session',
          parameters: [
            { name: 'session_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'after', in: 'query', required: false, schema: { type: 'string' }, description: 'Cursor <epoch>:<seq> or <seq>' },
            { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' }, description: 'SSE reconnect cursor (<epoch>:<seq> or <seq>); takes precedence over query after' },
            { name: 'grade', in: 'query', required: false, schema: { type: 'string', enum: ['turn', 'delta'], default: 'delta' } },
          ],
          responses: {
            '200': {
              description: 'Streaming session event frames or terminal reset frame',
              content: {
                'text/event-stream': {
                  schema: sessionStreamFrameSchema(),
                },
                'application/x-ndjson': {
                  schema: sessionStreamFrameSchema(),
                },
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorEnvelope' },
                },
              },
            },
          },
        },
      },
      '/api/events': {
        get: {
          operationId: 'streamGlobalEvents',
          tags: ['R2'],
          summary: 'Stateless global public event stream (SSE or NDJSON)',
          parameters: [
            { name: 'after', in: 'query', required: false, schema: { type: 'string' }, description: 'Cursor <epoch>:<seq> or <seq>' },
            { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' }, description: 'SSE reconnect cursor (<epoch>:<seq> or <seq>); takes precedence over query after' },
          ],
          responses: {
            '200': {
              description: 'Streaming global event frames or terminal reset frame',
              content: {
                'text/event-stream': {
                  schema: globalStreamFrameSchema(),
                },
                'application/x-ndjson': {
                  schema: globalStreamFrameSchema(),
                },
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorEnvelope' },
                },
              },
            },
          },
        },
      },
      '/api/llm:complete': {
        post: {
          operationId: 'llmComplete',
          tags: ['R3'],
          summary: 'Sessionless governed LLM completion with optional streaming and read-only context_from',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LlmCompleteRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completion result envelope or stream',
              content: {
                'application/json': {
                  schema: envelopeRef('LlmCompleteResponse'),
                },
                'text/event-stream': {
                  schema: { $ref: '#/components/schemas/LlmCompleteStreamEvent' },
                },
                'application/x-ndjson': {
                  schema: { $ref: '#/components/schemas/LlmCompleteStreamEvent' },
                },
              },
            },
          },
        },
      },
      '/api/sessions/{session_id}/interactions/{interaction_id}:respond': {
        post: {
          operationId: 'respondInteraction',
          tags: ['R4c'],
          summary: 'Stateless response to a pending user_tool interaction',
          parameters: [
            { name: 'session_id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'interaction_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InteractionRespondRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Interaction resolution receipt',
              content: {
                'application/json': {
                  schema: envelopeRef('InteractionRespondResult'),
                },
              },
            },
          },
        },
      },
    },
  };
}
