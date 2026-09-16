import { z } from 'zod';

export type InputJsonSchemaFinalizer = (schema: Record<string, unknown>) => void;

/** Projects a Zod schema to input JSON Schema with ordinary object nodes closed; `finalize` then
 *  attaches tool-specific AJV constraints, because Zod refinements and transforms do not survive
 *  the projection and conditional object probes must keep their intended open semantics. */
export function toInputJsonSchema(
  schema: z.ZodType,
  finalize?: InputJsonSchemaFinalizer,
): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  closeObjectNodes(jsonSchema);
  finalize?.(jsonSchema);
  ensureObjectRoot(jsonSchema);
  return jsonSchema;
}

const ROOT_COMPOSITE_KEYWORDS = ['oneOf', 'anyOf', 'allOf'] as const;

export function ensureObjectRoot(schema: Record<string, unknown>): void {
  if (schema['type'] !== undefined) return;
  if (typeof schema['$ref'] === 'string') return;
  const composite = ROOT_COMPOSITE_KEYWORDS.some((keyword) =>
    Array.isArray(schema[keyword]),
  );
  if (!composite && schema['properties'] === undefined) return;
  schema['type'] = 'object';
}

function closeObjectNodes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeObjectNodes(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }
  for (const child of Object.values(node)) {
    closeObjectNodes(child);
  }
}
