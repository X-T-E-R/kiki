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
