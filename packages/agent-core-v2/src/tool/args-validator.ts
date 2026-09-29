import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

const DRAFT_07_AJV = new Ajv({ strict: false, allErrors: true });
addFormats(DRAFT_07_AJV);

const DRAFT_2019_AJV = new Ajv2019({ strict: false, allErrors: true });
addFormats(DRAFT_2019_AJV);

const DRAFT_2020_AJV = new Ajv2020({ strict: false, allErrors: true });
addFormats(DRAFT_2020_AJV);

const DRAFT_2019_KEYWORDS = new Set([
  'dependentRequired',
  'dependentSchemas',
  'maxContains',
  'minContains',
  'unevaluatedItems',
  'unevaluatedProperties',
  '$recursiveAnchor',
  '$recursiveRef',
]);

const DRAFT_2020_KEYWORDS = new Set(['prefixItems', '$dynamicAnchor', '$dynamicRef']);

function ajvFor(schema: Record<string, unknown>): Ajv | Ajv2019 | Ajv2020 {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return DRAFT_2020_AJV;
    if ($schema.includes('2019-09')) return DRAFT_2019_AJV;
    return DRAFT_07_AJV;
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return DRAFT_2020_AJV;
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return DRAFT_2019_AJV;
  return DRAFT_07_AJV;
}

function containsSchemaKeyword(value: unknown, keywords: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsSchemaKeyword(item, keywords));
  }
  if (typeof value !== 'object' || value === null) return false;
  for (const [key, child] of Object.entries(value)) {
    if (keywords.has(key)) return true;
    if (containsSchemaKeyword(child, keywords)) return true;
  }
  return false;
}

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

export interface JsonArray extends Array<JsonType> {}

export interface JsonObject extends Record<string, JsonType> {}

export type ToolArgsValidator = ValidateFunction<JsonType>;

function formatValidationError(error: ErrorObject): string {
  if (error.keyword === 'required' && 'missingProperty' in error.params) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (error.keyword === 'additionalProperties' && 'additionalProperty' in error.params) {
    return `must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }

  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message ?? 'is invalid'}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return ajvFor(schema).compile(schema) as ToolArgsValidator;
}

export function validateToolArgs(validator: ToolArgsValidator, args: JsonType): string | null {
  const valid = validator(args);
  if (valid) {
    return null;
  }

  const errors = validator.errors ?? [];
  if (errors.length === 0) {
    return 'Tool parameter validation failed';
  }

  return errors.map((error) => formatValidationError(error)).join('; ');
}

export interface ToolArgsValidation {
  readonly args: unknown;
  readonly error: string | null;
}

export function validateToolArgsWithCoercion(
  validator: ToolArgsValidator,
  schema: Record<string, unknown>,
  args: unknown,
): ToolArgsValidation {
  const originalError = validateToolArgs(validator, args as JsonType);
  if (originalError === null) {
    return { args, error: null };
  }

  const coerced = coerceToolArgs(schema, args);
  if (coerced === args) {
    return { args, error: originalError };
  }

  if (validateToolArgs(validator, coerced as JsonType) === null) {
    return { args: coerced, error: null };
  }

  return { args, error: originalError };
}

export function coerceToolArgs(schema: Record<string, unknown>, args: unknown): unknown {
  return coerceValue([schema], args).value;
}

type SchemaObject = Record<string, unknown>;

type CoercionResult = {
  readonly value: unknown;
  readonly changed: boolean;
};

const JSON_NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function coerceValue(schemas: readonly SchemaObject[], value: unknown): CoercionResult {
  const alternatives = schemaAlternatives(schemas);
  if (alternatives === undefined || alternatives.length === 0) {
    return unchanged(value);
  }

  const targetType = consistentTargetType(alternatives);
  if (typeof value === 'string') {
    if (targetType === undefined || targetType === 'string') {
      return unchanged(value);
    }
    const converted = convertString(value, targetType);
    if (converted === undefined) {
      return unchanged(value);
    }
    const nested = coerceValue(schemas, converted);
    return { value: nested.value, changed: true };
  }

  if (Array.isArray(value)) {
    if (targetType !== undefined && targetType !== 'array') {
      return unchanged(value);
    }
    if (hasSchemaCombinator(schemas) && targetType === undefined) {
      return unchanged(value);
    }
    return coerceArray(schemas, value);
  }

  if (isSchemaValueObject(value)) {
    if (targetType !== undefined && targetType !== 'object') {
      return unchanged(value);
    }
    if (hasSchemaCombinator(schemas) && targetType === undefined) {
      return unchanged(value);
    }
    return coerceObject(schemas, value);
  }

  return unchanged(value);
}

function coerceArray(
  schemas: readonly SchemaObject[],
  value: readonly unknown[],
): CoercionResult {
  let result: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const childSchemas = schemasForItem(schemas, index);
    if (childSchemas === undefined) continue;
    const child = coerceValue(childSchemas, value[index]);
    if (!child.changed) continue;
    result ??= [...value];
    result[index] = child.value;
  }
  return result === undefined ? unchanged(value) : { value: result, changed: true };
}

function coerceObject(
  schemas: readonly SchemaObject[],
  value: Record<string, unknown>,
): CoercionResult {
  let result: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const childSchemas = schemasForProperty(schemas, key);
    if (childSchemas === undefined) continue;
    const child = coerceValue(childSchemas, value[key]);
    if (!child.changed) continue;
    result ??= { ...value };
    result[key] = child.value;
  }
  return result === undefined ? unchanged(value) : { value: result, changed: true };
}

function schemasForProperty(
  schemas: readonly SchemaObject[],
  property: string,
): readonly SchemaObject[] | undefined {
  const alternatives = schemaAlternatives(schemas);
  if (alternatives === undefined || alternatives.length === 0) return undefined;
  const children = alternatives.map((schema) => schemaProperty(schema, property));
  if (children.some((schema) => schema === undefined)) return undefined;
  return children as SchemaObject[];
}

function schemasForItem(
  schemas: readonly SchemaObject[],
  index: number,
): readonly SchemaObject[] | undefined {
  const alternatives = schemaAlternatives(schemas);
  if (alternatives === undefined || alternatives.length === 0) return undefined;
  const children = alternatives.map((schema) => schemaItem(schema, index));
  if (children.some((schema) => schema === undefined)) return undefined;
  return children as SchemaObject[];
}

function schemaProperty(schema: SchemaObject, property: string): SchemaObject | undefined {
  const properties = schema['properties'];
  if (!isSchemaValueObject(properties)) return undefined;
  return asSchemaObject(properties[property]);
}

function schemaItem(schema: SchemaObject, index: number): SchemaObject | undefined {
  const items = schema['items'];
  if (Array.isArray(items)) return asSchemaObject(items[index]);
  return asSchemaObject(items);
}

function schemaAlternatives(
  schemas: readonly SchemaObject[],
): SchemaObject[] | undefined {
  const alternatives: SchemaObject[] = [];
  for (const schema of schemas) {
    const anyOf = schema['anyOf'];
    const oneOf = schema['oneOf'];
    if (Array.isArray(anyOf) && Array.isArray(oneOf)) return undefined;
    const branches = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : undefined;
    if (branches === undefined) {
      alternatives.push(schema);
      continue;
    }
    if (branches.length === 0) return undefined;
    const branchSchemas = branches.map(asSchemaObject);
    if (branchSchemas.some((branch) => branch === undefined)) return undefined;
    const expanded = schemaAlternatives(branchSchemas as SchemaObject[]);
    if (expanded === undefined) return undefined;
    alternatives.push(...expanded);
  }
  return alternatives;
}

function consistentTargetType(schemas: readonly SchemaObject[]): string | undefined {
  const types = schemas.map((schema) => schemaType(schema));
  if (types.some((type) => type === undefined)) return undefined;
  const first = types[0];
  if (first === undefined || types.some((type) => type !== first)) return undefined;
  return first;
}

function schemaType(schema: SchemaObject): string | undefined {
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type) && type.length === 1 && typeof type[0] === 'string') {
    return type[0];
  }
  return undefined;
}

function hasSchemaCombinator(schemas: readonly SchemaObject[]): boolean {
  return schemas.some((schema) => Array.isArray(schema['anyOf']) || Array.isArray(schema['oneOf']));
}

function convertString(value: string, targetType: string): unknown {
  if (targetType === 'integer' || targetType === 'number') {
    const numeric = value.trim();
    if (!JSON_NUMBER_LITERAL.test(numeric)) return undefined;
    const converted = Number(numeric);
    if (!Number.isFinite(converted)) return undefined;
    if (targetType === 'integer' && !Number.isInteger(converted)) return undefined;
    return converted;
  }

  if (targetType === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }

  if (targetType !== 'array' && targetType !== 'object') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (targetType === 'array') return Array.isArray(parsed) ? parsed : undefined;
    return isSchemaValueObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function asSchemaObject(value: unknown): SchemaObject | undefined {
  return isSchemaValueObject(value) ? value : undefined;
}

function isSchemaValueObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unchanged(value: unknown): CoercionResult {
  return { value, changed: false };
}
