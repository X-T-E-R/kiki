import { describe, expect, it } from 'vitest';
import {
  buildRawSubstrateOpenApi,
  parseAndValidateStructuredOutput,
  validateJsonSchemaValue,
  validateSupportedOutputSchema,
  createSessionRequestSchema,
  promptSubmissionSchema,
  llmCompleteRequestSchema,
  interactionRespondRequestSchema,
} from '../index';

describe('raw substrate protocol schemas & OpenAPI 3.1', () => {
  it('builds a deterministic OpenAPI 3.1.0 document covering R1-R4(c) endpoints', () => {
    const first = buildRawSubstrateOpenApi();
    const second = buildRawSubstrateOpenApi();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first['openapi']).toBe('3.1.0');

    const paths = first['paths'] as Record<string, unknown>;
    expect(paths).toHaveProperty('/api/sessions');
    expect(paths).toHaveProperty('/api/sessions/{session_id}/prompts');
    expect(paths).toHaveProperty('/api/sessions/{session_id}/snapshot');
    expect(paths).toHaveProperty('/api/sessions/{session_id}/events');
    expect(paths).toHaveProperty('/api/events');
    expect(paths).toHaveProperty('/api/llm:complete');
    expect(paths).toHaveProperty('/api/sessions/{session_id}/interactions/{interaction_id}:respond');

    const schemas = (first['components'] as Record<string, unknown>)['schemas'] as Record<string, Record<string, unknown>>;
    expect(schemas['CreateSessionRequest']?.['properties']).toHaveProperty('mcp_servers');
    expect(schemas['CreateSessionRequest']?.['properties']).toHaveProperty('user_tools');
    expect(schemas['PromptSubmission']?.['properties']).toHaveProperty('wait');
    expect(schemas['PromptSubmission']?.['properties']).toHaveProperty('output_schema');
    expect(schemas['PromptSubmission']?.['properties']).toHaveProperty('include_thinking');
    expect(schemas['LlmCompleteRequest']?.['properties']).toHaveProperty('context_from');
    expect(schemas['SessionSnapshotResponse']?.['properties']).toHaveProperty('pending_user_tools');
  });

  it('validates declarative session mcp_servers, user_tools, R1 prompts, R3 llm:complete, and R4(c) respond', () => {
    const session = createSessionRequestSchema.parse({
      workspace_id: 'wd_demo_0123456789ab',
      private: true,
      ephemeral: true,
      mcp_servers: {
        local_http: { transport: 'http', url: 'http://127.0.0.1:4000/mcp', inherit: false },
        inferred_http: { url: 'http://127.0.0.1:4001/mcp' },
      },
      user_tools: [
        {
          name: 'lookup_record',
          description: 'Lookup one record',
          input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      ],
    });
    expect(session.mcp_servers?.['local_http']?.inherit).toBe(false);
    expect(session.user_tools?.[0]?.name).toBe('lookup_record');

    const prompt = promptSubmissionSchema.parse({
      content: [{ type: 'text', text: 'Return JSON' }],
      wait: true,
      include_thinking: true,
      output_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'number' } } },
    });
    expect(prompt.wait).toBe(true);

    const llm = llmCompleteRequestSchema.parse({
      messages: [{ role: 'user', content: 'hi' }],
      context_from: { session_id: 'sess-1', as_of_seq: 12 },
      stream: true,
    });
    expect(llm.context_from?.as_of_seq).toBe(12);

    expect(interactionRespondRequestSchema.parse({ result: 'ok' })).toEqual({ result: 'ok' });
    expect(interactionRespondRequestSchema.parse({ error: 'denied' })).toEqual({ error: 'denied' });
  });

  it('validates structured output against JSON Schema including fenced JSON blocks and failure details', () => {
    const schema = {
      type: 'object',
      required: ['verdict', 'score'],
      additionalProperties: false,
      properties: {
        verdict: { enum: ['pass', 'fail'] },
        score: { type: 'integer', minimum: 0, maximum: 100 },
      },
    };

    const ok = parseAndValidateStructuredOutput('```json\n{"verdict":"pass","score":95}\n```', schema);
    expect(ok).toEqual({ ok: true, value: { verdict: 'pass', score: 95 } });

    const invalid = parseAndValidateStructuredOutput('{"verdict":"maybe","score":150,"extra":true}', schema);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error).toContain('verdict');
      expect(invalid.error).toContain('score');
      expect(invalid.error).toContain('extra');
    }

    const issues = validateJsonSchemaValue({ verdict: 'maybe', score: 150, extra: true }, schema);
    expect(issues.map((item) => item.path)).toEqual(expect.arrayContaining(['verdict', 'score', 'extra']));

    const malformed = parseAndValidateStructuredOutput('not json at all', schema);
    expect(malformed.ok).toBe(false);

    expect(validateJsonSchemaValue([1, 2], { type: 'array', minItems: 3 })).toHaveLength(1);

    const refSchema = {
      type: 'object',
      $defs: { count: { type: 'integer', minimum: 1 } },
      required: ['n'],
      properties: { n: { $ref: '#/$defs/count' } },
    };
    expect(parseAndValidateStructuredOutput('{"n":3}', refSchema)).toEqual({ ok: true, value: { n: 3 } });
    expect(parseAndValidateStructuredOutput('{"n":"not-an-int"}', refSchema).ok).toBe(false);

    expect(validateSupportedOutputSchema({ $ref: 'https://example.test/schema.json' }).length).toBeGreaterThan(0);
    expect(validateSupportedOutputSchema({ type: 'object', patternProperties: { '^a': { type: 'string' } } }).length).toBeGreaterThan(0);

    const boolPropSchema = {
      type: 'object',
      $defs: { never: false },
      properties: {
        ok: true,
        forbidden: false,
        refForbidden: { $ref: '#/$defs/never' },
      },
    };
    expect(validateJsonSchemaValue({ ok: 'anything' }, boolPropSchema)).toEqual([]);
    expect(validateJsonSchemaValue({ forbidden: 1 }, boolPropSchema).length).toBeGreaterThan(0);
    expect(validateJsonSchemaValue({ refForbidden: 'x' }, boolPropSchema).length).toBeGreaterThan(0);

    expect(
      validateJsonSchemaValue(
        [{ a: 1, b: 2 }, { b: 2, a: 1 }],
        { type: 'array', uniqueItems: true },
      ).length,
    ).toBeGreaterThan(0);
    expect(
      validateJsonSchemaValue(
        { b: 2, a: 1 },
        { const: { a: 1, b: 2 } },
      ),
    ).toEqual([]);

    const doc = buildRawSubstrateOpenApi();
    const paths = doc['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const sessionStreamSchema = (
      (paths['/api/sessions/{session_id}/events']!['get']!['responses'] as Record<string, Record<string, Record<string, Record<string, unknown>>>>)['200']!['content']!['application/x-ndjson']!['schema']
    ) as Record<string, unknown>;
    const defs = (doc['components'] as Record<string, Record<string, unknown>>)['schemas'];
    const rewrittenSchema = JSON.parse(
      JSON.stringify({ ...sessionStreamSchema, $defs: defs }).replaceAll('#/components/schemas/', '#/$defs/'),
    ) as Record<string, unknown>;
    expect(validateJsonSchemaValue({ type: 'reset', epoch: 'e1', latest_seq: 3, reason: 'buffer_overflow' }, rewrittenSchema)).toEqual([]);
    expect(validateJsonSchemaValue({ type: 'tool.requires_action', epoch: 'e1', seq: 4, session_id: 's1', agent_id: 'main', timestamp: '2026-01-01T00:00:00Z', interaction_id: 'i1', tool_call_id: 'tc1', name: 't', args: {} }, rewrittenSchema)).toEqual([]);
    expect(validateJsonSchemaValue({ type: 'context.undo', epoch: 'e1', seq: 5, session_id: 's1', agent_id: 'main', turns: 1, timestamp: '2026-01-01T00:00:00Z', removed_turn_ids: [1] }, rewrittenSchema)).toEqual([]);
    expect(validateJsonSchemaValue({ type: 'turn.started', epoch: 'e1', seq: 6, session_id: 's1', timestamp: '2026-01-01T00:00:00Z', payload: { turnId: 1 } }, rewrittenSchema)).toEqual([]);
  });
});
