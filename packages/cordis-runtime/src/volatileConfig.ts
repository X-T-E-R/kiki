import type { StandardSchemaV1 } from '@standard-schema/spec';
import { deepEqual, updateVolatile, volatileEntries } from './vendor/cosmokit/index.ts';
import type Schema from './vendor/schemastery/index.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function equal(a: unknown, b: unknown, schema: Schema | undefined, ancestors: Set<Schema>): boolean {
  if (schema?.meta?.volatile) return true;
  if (schema?.type !== 'object' || !schema.dict || ancestors.has(schema)) return deepEqual(a, b, true);
  const left = a ?? schema.meta.default;
  const right = b ?? schema.meta.default;
  if (!isRecord(left) || !isRecord(right)) return deepEqual(left, right, true);
  ancestors.add(schema);
  try {
    return Object.keys({ ...left, ...right }).every(key => equal(left[key], right[key], schema.dict![key], ancestors));
  } finally {
    ancestors.delete(schema);
  }
}

/** Compare raw options at fixed schema paths without evaluating validation hooks. */
export function equalExceptVolatile(previous: unknown, next: unknown, schema?: StandardSchemaV1): boolean {
  return schema?.['~standard'].vendor === 'schemastery'
    ? equal(previous, next, schema as Schema, new Set())
    : deepEqual(previous, next, true);
}

/** Commit only when every ordinary effective value and volatile path remains equal. */
export function commitVolatileConfig(previous: unknown, next: unknown): boolean {
  if (!deepEqual(previous, next, true)) return false;
  const before = volatileEntries(previous);
  const after = volatileEntries(next);
  if (before.length !== after.length || before.some((entry, index) => !deepEqual(entry.path, after[index]!.path, true))) return false;
  for (let index = 0; index < before.length; index++) updateVolatile(before[index]!.ref, after[index]!.ref);
  return true;
}
