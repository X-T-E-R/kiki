import { describe, expect, it } from 'vitest';
import type { Message } from '#/kosong/contract/message';
import { projectDynamicToolSchemas } from '#/agent/llmRequester/dynamicToolProjection';

const schema: Message = {
  role: 'system', content: [], toolCalls: [],
  tools: [{ name: 'mcp__srv__read', description: 'Read a record.', parameters: { type: 'object' } }],
};
const user: Message = { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] };

describe('projectDynamicToolSchemas', () => {
  it.each(['openai', 'openai_responses', 'anthropic'] as const)('%s renders each loaded schema as one stable system message', (protocol) => {
    const history = [user, schema, user];
    const first = projectDynamicToolSchemas(history, protocol, false);
    const second = projectDynamicToolSchemas(history, protocol, false);
    expect(first).toEqual(second);
    expect(first[0]).toBe(user);
    expect(first[2]).toBe(user);
    expect(first[1]).toEqual({
      role: 'system', toolCalls: [],
      content: [{ type: 'text', text: '<dynamic_tool_schemas>[{"name":"mcp__srv__read","description":"Read a record.","parameters":{"type":"object"}}]</dynamic_tool_schemas>' }],
    });
    expect(schema.tools).toHaveLength(1);
  });

  it('keeps the native message tools field for Kimi', () => {
    expect(projectDynamicToolSchemas([schema], 'openai', true)).toEqual([schema]);
  });
});
