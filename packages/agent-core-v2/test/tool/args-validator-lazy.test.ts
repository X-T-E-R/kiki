import { expect, it, vi } from 'vitest';

const counts = vi.hoisted(() => [0, 0, 0]);

vi.mock('ajv', async (original) => {
  const actual = await original<typeof import('ajv')>();
  return { ...actual, default: class extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) { super(...args); counts[0]!++; }
  } };
});
vi.mock('ajv/dist/2019', async (original) => {
  const actual = await original<typeof import('ajv/dist/2019')>();
  return { ...actual, default: class extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) { super(...args); counts[1]!++; }
  } };
});
vi.mock('ajv/dist/2020', async (original) => {
  const actual = await original<typeof import('ajv/dist/2020')>();
  return { ...actual, default: class extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) { super(...args); counts[2]!++; }
  } };
});

it('constructs each formatted Ajv dialect only on first compilation', async () => {
  const { compileToolArgsValidator, validateToolArgs } = await import('#/tool/args-validator');
  expect(counts).toEqual([0, 0, 0]);
  for (const [index, schemaUri] of [
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ].entries()) {
    const schema = { $schema: schemaUri, type: 'string', format: 'email' };
    const validator = compileToolArgsValidator(schema);
    expect(validateToolArgs(validator, 'a@example.com')).toBeNull();
    expect(validateToolArgs(validator, 'invalid')).toContain('format');
    compileToolArgsValidator(schema);
    expect(counts).toEqual([0, 1, 2].map((dialect) => dialect <= index ? 1 : 0));
  }
});
