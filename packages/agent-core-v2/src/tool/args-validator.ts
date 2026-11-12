import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

type AnyAjv = Ajv | Ajv2019 | Ajv2020;

let draft07Ajv: Ajv | undefined;
let draft2019Ajv: Ajv2019 | undefined;
let draft2020Ajv: Ajv2020 | undefined;

function withFormats<T extends AnyAjv>(ajv: T): T {
  addFormats(ajv);
  return ajv;
}

function draft07(): Ajv {
  return (draft07Ajv ??= withFormats(new Ajv({ strict: false, allErrors: true })));
}

function draft2019(): Ajv2019 {
  return (draft2019Ajv ??= withFormats(new Ajv2019({ strict: false, allErrors: true })));
}

function draft2020(): Ajv2020 {
  return (draft2020Ajv ??= withFormats(new Ajv2020({ strict: false, allErrors: true })));
}

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

function ajvFor(schema: Record<string, unknown>): AnyAjv {
  const $schema = schema['$schema'];
  if (typeof $schema === 'string') {
    if ($schema.includes('2020-12')) return draft2020();
    if ($schema.includes('2019-09')) return draft2019();
    return draft07();
  }
  if (containsSchemaKeyword(schema, DRAFT_2020_KEYWORDS)) return draft2020();
  if (containsSchemaKeyword(schema, DRAFT_2019_KEYWORDS)) return draft2019();
  return draft07();
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
  if (error.keyword === 'enum' && Array.isArray(error.params['allowedValues'])) {
    return `${path}must be equal to one of the allowed values: ${error.params['allowedValues'].map((value) => JSON.stringify(value)).join(', ')}`;
  }
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

  const schema = asSchemaObject(validator.schema);
  if (schema === undefined) {
    return errors.map((error) => formatValidationError(error)).join('; ');
  }
  return describeValidationErrors(schema, args, errors);
}

interface UnionBranchSelection {
  readonly prefix: string;
  readonly label: string;
}

function describeValidationErrors(
  schema: SchemaObject,
  args: unknown,
  errors: readonly ErrorObject[],
): string {
  const discriminated = selectDiscriminatedBranch(schema, args);
  if (typeof discriminated === 'string') return discriminated;
  const selected = discriminated === undefined
    ? errors
    : errors.filter((error) => error.schemaPath.startsWith(discriminated.prefix));
  const requiredChoices = selected
    .filter((error) => error.keyword === 'anyOf' && requiredOnlyChoices(schemaAt(schema, error.schemaPath)) !== undefined)
    .map((error) => `${error.schemaPath}/`);
  const messages: string[] = [];
  for (const error of selected) {
    if (error.keyword === 'if') continue;
    if (requiredChoices.some((prefix) => error.schemaPath.startsWith(prefix))) continue;
    const message = describeValidationError(schema, args, error);
    if (!messages.includes(message)) messages.push(message);
  }
  const text = messages.length > 0 ? messages.join('; ') : errors.map((error) => formatValidationError(error)).join('; ');
  return discriminated === undefined ? text : `with ${discriminated.label}: ${text}`;
}

function describeValidationError(schema: SchemaObject, args: unknown, error: ErrorObject): string {
  const path = error.instancePath ? `${error.instancePath} ` : '';
  if (error.keyword === 'anyOf') {
    const choices = requiredOnlyChoices(schemaAt(schema, error.schemaPath));
    if (choices !== undefined) return `${path}must have at least one of ${quotedList(choices, 'or')}`;
  }
  if (error.keyword === 'not') {
    const described = describeExclusion(schema, args, error);
    if (described !== undefined) return described;
  }
  const condition = thenCondition(schema, error.schemaPath);
  const message = formatValidationError(error);
  return condition === undefined ? message : `${message} when ${condition.text}`;
}

function describeExclusion(schema: SchemaObject, args: unknown, error: ErrorObject): string | undefined {
  const target = valueAtPointer(args, error.instancePath);
  if (!isSchemaValueObject(target)) return undefined;
  const named = requiredNames(schemaAt(schema, error.schemaPath)).filter((name) => Object.hasOwn(target, name));
  if (named.length === 0) return undefined;
  const path = error.instancePath ? `${error.instancePath} ` : '';
  const condition = thenCondition(schema, error.schemaPath);
  if (condition === undefined) return `${path}${quotedList(named, 'and')} cannot be used together`;
  const others = named.filter((name) => !condition.fields.includes(name));
  return `${path}${quotedList(others.length > 0 ? others : named, 'and')} cannot be used when ${condition.text}`;
}

function selectDiscriminatedBranch(schema: SchemaObject, args: unknown): UnionBranchSelection | string | undefined {
  const keyword = Array.isArray(schema['oneOf']) ? 'oneOf' : Array.isArray(schema['anyOf']) ? 'anyOf' : undefined;
  if (keyword === undefined || !isSchemaValueObject(args)) return undefined;
  const branches = (schema[keyword] as unknown[]).map(asSchemaObject);
  if (branches.length < 2 || branches.some((branch) => branch === undefined)) return undefined;
  const discriminator = discriminatorOf(branches as SchemaObject[]);
  if (discriminator === undefined) return undefined;
  const allowed = discriminator.values.map((value) => JSON.stringify(value)).join(', ');
  if (!Object.hasOwn(args, discriminator.key)) {
    return `must have required property '${discriminator.key}' (one of ${allowed})`;
  }
  const index = discriminator.values.indexOf(args[discriminator.key] as string | number | boolean);
  if (index < 0) return `/${discriminator.key} must be one of ${allowed}`;
  return {
    prefix: `#/${keyword}/${String(index)}/`,
    label: `${discriminator.key} ${JSON.stringify(discriminator.values[index])}`,
  };
}

function discriminatorOf(
  branches: readonly SchemaObject[],
): { readonly key: string; readonly values: readonly (string | number | boolean)[] } | undefined {
  const first = branches[0]?.['properties'];
  if (!isSchemaValueObject(first)) return undefined;
  for (const key of Object.keys(first)) {
    const values = branches.map((branch) => constantOf(asSchemaObject(asSchemaObject(branch['properties'])?.[key])));
    if (values.some((value) => value === undefined)) continue;
    if (new Set(values).size !== values.length) continue;
    return { key, values: values as (string | number | boolean)[] };
  }
  return undefined;
}

function constantOf(schema: SchemaObject | undefined): string | number | boolean | undefined {
  if (schema === undefined) return undefined;
  const value = schema['const'] ?? (Array.isArray(schema['enum']) && schema['enum'].length === 1 ? schema['enum'][0] : undefined);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
}

function requiredOnlyChoices(branches: unknown): readonly string[] | undefined {
  if (!Array.isArray(branches)) return undefined;
  const names: string[] = [];
  for (const branch of branches) {
    if (!isSchemaValueObject(branch) || Object.keys(branch).length !== 1 || !Array.isArray(branch['required'])) return undefined;
    for (const name of branch['required']) {
      if (typeof name !== 'string') return undefined;
      names.push(name);
    }
  }
  return names.length > 0 ? names : undefined;
}

function requiredNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(requiredNames);
  if (!isSchemaValueObject(schema)) return [];
  const own = Array.isArray(schema['required']) ? schema['required'].filter((name): name is string => typeof name === 'string') : [];
  const nested = ['allOf', 'anyOf', 'oneOf'].flatMap((keyword) => requiredNames(schema[keyword]));
  return [...new Set([...own, ...nested])];
}

function thenCondition(
  schema: SchemaObject,
  schemaPath: string,
): { readonly fields: readonly string[]; readonly text: string } | undefined {
  const marker = schemaPath.lastIndexOf('/then/');
  if (marker < 0) return undefined;
  const condition = asSchemaObject(asSchemaObject(schemaAt(schema, schemaPath.slice(0, marker)))?.['if']);
  if (condition === undefined || !Array.isArray(condition['required'])) return undefined;
  const fields = condition['required'].filter((name): name is string => typeof name === 'string');
  if (fields.length === 0) return undefined;
  const properties = asSchemaObject(condition['properties']);
  const text = fields.map((field) => {
    const value = constantOf(asSchemaObject(properties?.[field]));
    return value === undefined ? `'${field}' is given` : `'${field}' is ${JSON.stringify(value)}`;
  }).join(' and ');
  return { fields, text };
}

function schemaAt(schema: SchemaObject, schemaPath: string): unknown {
  if (!schemaPath.startsWith('#')) return undefined;
  return valueAtPointer(schema, schemaPath.slice(1));
}

function valueAtPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current = value;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isSchemaValueObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

function quotedList(names: readonly string[], conjunction: 'and' | 'or'): string {
  const quoted = names.map((name) => `'${name}'`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} ${conjunction} ${quoted.at(-1)!}`;
}

export interface ToolArgsValidation {
  readonly args: unknown;
  readonly error: string | null;
  /** Arguments the schema does not declare anywhere that were removed so the call could run, as dotted paths. */
  readonly ignored?: readonly string[];
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
  if (coerced !== args && validateToolArgs(validator, coerced as JsonType) === null) {
    return { args: coerced, error: null };
  }

  const stripped = stripUnknownArguments(validator, schema, coerced);
  if (stripped === undefined) return { args, error: originalError };
  if (stripped.suggestions.length > 0) {
    const remaining = validateToolArgs(validator, stripped.args as JsonType);
    return { args, error: [...stripped.suggestions, ...(remaining === null ? [] : [remaining])].join('; ') };
  }
  if (validateToolArgs(validator, stripped.args as JsonType) !== null) return { args, error: originalError };
  return { args: stripped.args, error: null, ignored: stripped.ignored };
}

interface StrippedArguments {
  readonly args: unknown;
  readonly ignored: readonly string[];
  readonly suggestions: readonly string[];
}

function stripUnknownArguments(
  validator: ToolArgsValidator,
  schema: SchemaObject,
  value: unknown,
): StrippedArguments | undefined {
  if (validator(value as JsonType)) return undefined;
  const unknown: Array<{ readonly pointer: string; readonly name: string }> = [];
  for (const error of validator.errors ?? []) {
    if (error.keyword !== 'additionalProperties' || typeof error.params['additionalProperty'] !== 'string') continue;
    const name = error.params['additionalProperty'];
    if (unknown.some((entry) => entry.pointer === error.instancePath && entry.name === name)) continue;
    const nodes = schemaNodesAt(schema, pointerSegments(error.instancePath));
    if (nodes.some((node) => declaresProperty(node, name))) continue;
    unknown.push({ pointer: error.instancePath, name });
  }
  if (unknown.length === 0) return undefined;
  let args = value;
  const ignored: string[] = [];
  const suggestions: string[] = [];
  for (const { pointer, name } of unknown) {
    const owner = valueAtPointer(value, pointer);
    const supplied = isSchemaValueObject(owner) ? new Set(Object.keys(owner)) : new Set<string>();
    const declared = [...new Set(schemaNodesAt(schema, pointerSegments(pointer)).flatMap(declaredPropertyNames))];
    const label = [...pointerSegments(pointer), name].join('.');
    const intended = declared.find((candidate) => !supplied.has(candidate) && isNearMiss(name, candidate));
    if (intended !== undefined) {
      const intendedLabel = [...pointerSegments(pointer), intended].join('.');
      suggestions.push(`unknown argument '${label}'; did you mean '${intendedLabel}'?`);
    }
    args = withoutProperty(args, pointerSegments(pointer), name);
    ignored.push(label);
  }
  return { args, ignored, suggestions };
}

function withoutProperty(value: unknown, segments: readonly string[], name: string): unknown {
  if (segments.length === 0) {
    if (!isSchemaValueObject(value)) return value;
    const copy = { ...value };
    Reflect.deleteProperty(copy, name);
    return copy;
  }
  const [head, ...rest] = segments;
  if (Array.isArray(value)) {
    const index = Number(head);
    const copy = [...value];
    copy[index] = withoutProperty(value[index], rest, name);
    return copy;
  }
  if (!isSchemaValueObject(value)) return value;
  return { ...value, [head!]: withoutProperty(value[head!], rest, name) };
}

function pointerSegments(pointer: string): string[] {
  return pointer === '' ? [] : pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function schemaNodesAt(root: SchemaObject, segments: readonly string[]): SchemaObject[] {
  let current = expandSchemaNode(root, root);
  for (const segment of segments) {
    const next: SchemaObject[] = [];
    for (const node of current) {
      const property = asSchemaObject(asSchemaObject(node['properties'])?.[segment]);
      if (property !== undefined) next.push(property);
      const patterns = asSchemaObject(node['patternProperties']);
      for (const [pattern, child] of Object.entries(patterns ?? {})) {
        const childSchema = asSchemaObject(child);
        if (childSchema !== undefined && matchesPattern(pattern, segment)) next.push(childSchema);
      }
      const additional = asSchemaObject(node['additionalProperties']);
      if (additional !== undefined) next.push(additional);
      const items = node['items'];
      const prefix = node['prefixItems'];
      if (Array.isArray(prefix)) {
        const item = asSchemaObject(prefix[Number(segment)]);
        if (item !== undefined) next.push(item);
      }
      if (Array.isArray(items)) {
        const item = asSchemaObject(items[Number(segment)]);
        if (item !== undefined) next.push(item);
      } else {
        const item = asSchemaObject(items);
        if (item !== undefined) next.push(item);
      }
    }
    current = next.flatMap((node) => expandSchemaNode(node, root));
  }
  return current;
}

function expandSchemaNode(node: SchemaObject, root: SchemaObject, seen = new Set<SchemaObject>()): SchemaObject[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const nodes = [node];
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#')) {
    const target = asSchemaObject(valueAtPointer(root, ref.slice(1)));
    if (target !== undefined) nodes.push(...expandSchemaNode(target, root, seen));
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const branches = node[keyword];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const branchSchema = asSchemaObject(branch);
      if (branchSchema !== undefined) nodes.push(...expandSchemaNode(branchSchema, root, seen));
    }
  }
  for (const keyword of ['then', 'else']) {
    const branch = asSchemaObject(node[keyword]);
    if (branch !== undefined) nodes.push(...expandSchemaNode(branch, root, seen));
  }
  return nodes;
}

function declaresProperty(node: SchemaObject, name: string): boolean {
  if (Object.hasOwn(asSchemaObject(node['properties']) ?? {}, name)) return true;
  return Object.keys(asSchemaObject(node['patternProperties']) ?? {}).some((pattern) => matchesPattern(pattern, name));
}

function declaredPropertyNames(node: SchemaObject): string[] {
  return Object.keys(asSchemaObject(node['properties']) ?? {});
}

function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return false;
  }
}

function isNearMiss(name: string, candidate: string): boolean {
  const left = normalizedArgumentName(name);
  const right = normalizedArgumentName(candidate);
  if (left === right) return true;
  return Math.min(left.length, right.length) >= 4 && editDistance(left, right) <= 1;
}

function normalizedArgumentName(name: string): string {
  return name.toLowerCase().replaceAll(/[_-]/g, '');
}

function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)));
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(rows[row - 1]![column]! + 1, rows[row]![column - 1]! + 1, rows[row - 1]![column - 1]! + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, rows[row - 2]![column - 2]! + 1);
      }
      rows[row]![column] = best;
    }
  }
  return rows[left.length]![right.length]!;
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
