import { describe, expect, it } from 'vitest';

import {
  compileToolArgsValidator,
  type JsonType,
  validateToolArgs,
  validateToolArgsWithCoercion,
} from '#/tool/args-validator';

function validate(schema: Record<string, unknown>, value: JsonType): string | null {
  return validateToolArgs(compileToolArgsValidator(schema), value);
}

function validateWithCoercion(schema: Record<string, unknown>, value: JsonType) {
  return validateToolArgsWithCoercion(compileToolArgsValidator(schema), schema, value);
}

describe('args-validator (Ajv, format support)', () => {
  it('validates string format (email)', () => {
    const schema = { type: 'string', format: 'email' };
    expect(validate(schema, 'a@b.com')).toBeNull();
    expect(validate(schema, 'not-an-email')).toContain('format');
  });

  it('validates string format (uri)', () => {
    const schema = { type: 'string', format: 'uri' };
    expect(validate(schema, 'https://example.com/x')).toBeNull();
    expect(validate(schema, 'not a uri')).toContain('format');
  });

  it('recompiles refreshed schemas that reuse the same $id', () => {
    const first = { $id: 'https://example.test/tool', type: 'object', required: ['a'] };
    const refreshed = { $id: 'https://example.test/tool', type: 'object', required: ['b'] };
    const firstValidator = compileToolArgsValidator(first);
    expect(validate(refreshed, { a: 1 })).toContain("must have required property 'b'");
    expect(validateToolArgs(firstValidator, { a: 1 })).toBeNull();
  });

  it('rejects a schema claiming a metaschema $id without unregistering the metaschema', () => {
    expect(() => compileToolArgsValidator({ $id: 'http://json-schema.org/draft-07/schema#', type: 'object' })).toThrow('already exists');
    expect(validate({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'string' }, 'ok')).toBeNull();
  });

  it('does not retain nested $id registrations between compilations', () => {
    const nested = () => ({
      type: 'object',
      properties: { item: { $id: 'https://example.test/item', type: 'string' } },
      required: ['item'],
    });
    expect(validate(nested(), { item: 'x' })).toBeNull();
    expect(validate(nested(), { item: 1 })).toContain('must be string');
  });

  it('format is ignored on non-strings', () => {
    const schema = { type: 'number', format: 'email' };
    expect(validate(schema, 42)).toBeNull();
  });

  it('keeps required / additionalProperties messages', () => {
    expect(validate({ type: 'object', required: ['a'] }, {})).toContain(
      "must have required property 'a'",
    );
    expect(
      validate({ type: 'object', properties: { a: {} }, additionalProperties: false }, { b: 1 }),
    ).toContain("must NOT have additional property 'b'");
  });

  it('still validates the JSON-Schema subset (type / enum / const)', () => {
    expect(validate({ type: 'integer' }, 1.5)).toContain('must be integer');
    expect(validate({ enum: ['a', 'b'] }, 'c')).toContain('allowed values');
    expect(validate({ const: 'x' }, 'y')).toContain('constant');
  });

  it('coerces scalar and JSON container strings recursively after validation fails', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        ratio: { type: 'number' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
        settings: {
          type: 'object',
          properties: { level: { type: 'integer' } },
          required: ['level'],
        },
        values: { type: 'array', items: { type: 'integer' } },
      },
      required: ['count', 'ratio', 'enabled', 'tags', 'nested', 'settings', 'values'],
      additionalProperties: false,
    };
    const input: JsonType = {
      count: ' 3 ',
      ratio: '1.5',
      enabled: 'true',
      tags: '["a"]',
      nested: { count: '4' },
      settings: '{"level":"7"}',
      values: ['5', '6'],
    };

    const result = validateWithCoercion(schema, input);

    expect(result.error).toBeNull();
    expect(result.args).toEqual({
      count: 3,
      ratio: 1.5,
      enabled: true,
      tags: ['a'],
      nested: { count: 4 },
      settings: { level: 7 },
      values: [5, 6],
    });
    expect(result.args).not.toBe(input);
    expect(input).toEqual({
      count: ' 3 ',
      ratio: '1.5',
      enabled: 'true',
      tags: '["a"]',
      nested: { count: '4' },
      settings: '{"level":"7"}',
      values: ['5', '6'],
    });
  });

  it.each(['3.5', '', 'abc', '0x10', '1e999'])('rejects invalid integer strings (%s)', (value) => {
    const result = validateWithCoercion({ type: 'integer' }, value);

    expect(result.error).toContain('must be integer');
    expect(result.args).toBe(value);
  });

  it('does not coerce numbers into string fields', () => {
    const input: JsonType = { value: 3 };
    const result = validateWithCoercion(
      { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      input,
    );

    expect(result.error).toContain('must be string');
    expect(result.args).toBe(input);
  });

  it('skips coercion when anyOf target types are inconsistent', () => {
    const result = validateWithCoercion(
      { anyOf: [{ type: 'integer' }, { type: 'number' }] },
      '3',
    );

    expect(result.error).toContain('must be integer');
    expect(result.args).toBe('3');
  });

  it('keeps a string unchanged when the schema also allows strings', () => {
    const result = validateWithCoercion(
      { anyOf: [{ type: 'integer' }, { type: 'string' }] },
      '3',
    );

    expect(result.error).toBeNull();
    expect(result.args).toBe('3');
  });
});

describe('args-validator cross-field messages', () => {
  const actionUnion = {
    type: 'object',
    oneOf: [
      { type: 'object', properties: { action: { const: 'create' }, cron: { type: 'string' } }, required: ['action', 'cron'], additionalProperties: false },
      { type: 'object', properties: { action: { const: 'delete' }, id: { type: 'string' } }, required: ['action', 'id'], additionalProperties: false },
    ],
  };

  it('reports only the errors of the branch selected by the discriminator', () => {
    const error = validate(actionUnion, { action: 'delete' });
    expect(error).toContain("'id'");
    expect(error).not.toContain("'cron'");
    expect(validate(actionUnion, { action: 'list' })).toContain('"create", "delete"');
  });

  it('names the fields of a violated exclusion instead of "must NOT be valid"', () => {
    const schema = {
      type: 'object',
      properties: { cursor: { type: 'string' }, order: { type: 'string' }, resume: { type: 'string' }, profile: { type: 'string' } },
      allOf: [
        // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema uses the reserved `then` keyword.
        { if: { required: ['cursor'] }, then: { not: { anyOf: [{ required: ['order'] }] } } },
        { not: { allOf: [{ required: ['resume'] }, { anyOf: [{ required: ['profile'] }] }] } },
      ],
    };
    const conditional = validate(schema, { cursor: 'c', order: 'oldest' });
    expect(conditional).toContain("'order'");
    expect(conditional).toContain("'cursor'");
    const exclusive = validate(schema, { resume: 'r', profile: 'p' });
    expect(exclusive).toContain("'resume'");
    expect(exclusive).toContain("'profile'");
    for (const message of [conditional, exclusive]) expect(message).not.toContain('must NOT be valid');
  });
});

describe('args-validator unknown arguments', () => {
  const closed = {
    type: 'object',
    properties: { path: { type: 'string' }, replace_all: { type: 'boolean' }, options: { type: 'object', properties: { depth: { type: 'integer' } }, additionalProperties: false } },
    required: ['path'],
    additionalProperties: false,
  };

  it('rejects undeclared arguments instead of stripping them', () => {
    const rootExtra: JsonType = { path: 'a', reason: 'x' };
    expect(validateWithCoercion(closed, rootExtra)).toEqual({
      args: rootExtra,
      error: "must NOT have additional property 'reason'",
    });

    const nestedExtra: JsonType = { path: 'a', options: { depth: '2', why: 'y' } };
    const nestedResult = validateWithCoercion(closed, nestedExtra);
    expect(nestedResult.args).toBe(nestedExtra);
    expect(nestedResult.error).toContain("must NOT have additional property 'why'");
  });

  it('rejects a near miss of a declared argument and names the intended one, and still rejects when supplied alongside it', () => {
    const result = validateWithCoercion(closed, { path: 'a', replace_al: true });
    expect(result.error).toContain("must NOT have additional property 'replace_al'");
    expect(result.error).toContain("did you mean 'replace_all'");

    const duplicate = validateWithCoercion(closed, { path: 'a', replace_all: true, replace_al: true });
    expect(duplicate.error).toContain("must NOT have additional property 'replace_al'");
  });

  it('rejects extra properties on union branches', () => {
    const union = {
      type: 'object',
      oneOf: [
        { type: 'object', properties: { action: { const: 'list' } }, required: ['action'], additionalProperties: false },
        { type: 'object', properties: { action: { const: 'delete' }, id: { type: 'string' } }, required: ['action', 'id'], additionalProperties: false },
      ],
    };
    const deleteWithReason = validateWithCoercion(union, { action: 'delete', id: 'j1', reason: 'x' });
    expect(deleteWithReason.error).toContain("must NOT have additional property 'reason'");
    expect(deleteWithReason.args).toEqual({ action: 'delete', id: 'j1', reason: 'x' });

    const listWithId = validateWithCoercion(union, { action: 'list', id: 'j1', reason: 'x' });
    expect(listWithId.error).toContain("'id'");
    expect(listWithId.args).toEqual({ action: 'list', id: 'j1', reason: 'x' });
  });

  it('passes extra properties through when the schema allows them', () => {
    const open = { type: 'object', properties: { path: { type: 'string' } } };
    const input: JsonType = { path: 'a', reason: 'x' };
    expect(validateWithCoercion(open, input)).toEqual({ args: input, error: null });
  });
});
