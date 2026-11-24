export interface JsonSchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  '$ref',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'prefixItems',
  'required',
  'properties',
  'propertyNames',
  'additionalProperties',
  'minProperties',
  'maxProperties',
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const entries: string[] = [];
  for (const key of keys) {
    if (record[key] === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  }
  return `{${entries.join(',')}}`;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalRef(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | boolean | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined;
    const segment = decodeJsonPointerSegment(rawSegment);
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      const obj = current as Record<string, unknown>;
      if (!Object.hasOwn(obj, segment)) return undefined;
      current = obj[segment];
    }
  }
  if (typeof current === 'boolean') return current;
  return current !== null && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined;
}

function inspectSchemaNode(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  path: string,
  issues: JsonSchemaValidationIssue[],
  seen: Set<object>,
): void {
  if (seen.has(node)) return;
  seen.add(node);
  for (const [key, child] of Object.entries(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      issues.push({ path: path ? `${path}.${key}` : key, message: `unsupported JSON Schema keyword "${key}"` });
      continue;
    }
    if (key === '$ref') {
      if (typeof child !== 'string' || !child.startsWith('#')) {
        issues.push({ path: path ? `${path}.$ref` : '$ref', message: 'only local JSON Pointer $ref ("#...") is supported' });
      } else if (resolveLocalRef(root, child) === undefined) {
        issues.push({ path: path ? `${path}.$ref` : '$ref', message: `unresolved local $ref "${child}"` });
      }
      continue;
    }
    if (key === 'properties' || key === '$defs' || key === 'definitions') {
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        for (const [subKey, subSchema] of Object.entries(child as Record<string, unknown>)) {
          if (subSchema !== null && typeof subSchema === 'object' && !Array.isArray(subSchema)) {
            inspectSchemaNode(subSchema as Record<string, unknown>, root, path ? `${path}.${key}.${subKey}` : `${key}.${subKey}`, issues, seen);
          }
        }
      }
      continue;
    }
    if ((key === 'items' || key === 'additionalProperties' || key === 'propertyNames' || key === 'not') && child !== null && typeof child === 'object' && !Array.isArray(child)) {
      inspectSchemaNode(child as Record<string, unknown>, root, path ? `${path}.${key}` : key, issues, seen);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'prefixItems' || key === 'items') && Array.isArray(child)) {
      for (let i = 0; i < child.length; i += 1) {
        const entry = child[i];
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          inspectSchemaNode(entry as Record<string, unknown>, root, `${path ? `${path}.` : ''}${key}[${i}]`, issues, seen);
        }
      }
    }
  }
}

/** Validate that an `output_schema` uses only locally resolvable `$ref`s and supported JSON Schema keywords. */
export function validateSupportedOutputSchema(schema: Record<string, unknown>): readonly JsonSchemaValidationIssue[] {
  const issues: JsonSchemaValidationIssue[] = [];
  inspectSchemaNode(schema, schema, '', issues, new Set());
  return issues;
}

function typeOfJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOfJson(value) === expected;
}

function isSubschema(value: unknown): value is Record<string, unknown> | boolean {
  return typeof value === 'boolean' || (typeof value === 'object' && value !== null && !Array.isArray(value));
}

function validateNode(
  value: unknown,
  schema: Record<string, unknown> | boolean,
  root: Record<string, unknown>,
  path: string,
  issues: JsonSchemaValidationIssue[],
  refStack: ReadonlySet<string>,
): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push({ path, message: 'value forbidden by false schema' });
    return;
  }
  if (typeof schema['$ref'] === 'string') {
    const ref = schema['$ref'];
    if (refStack.has(ref)) {
      issues.push({ path, message: `cyclic $ref "${ref}"` });
      return;
    }
    const target = resolveLocalRef(root, ref);
    if (target === undefined) {
      issues.push({ path, message: `unresolved $ref "${ref}"` });
      return;
    }
    const nextStack = new Set(refStack);
    nextStack.add(ref);
    validateNode(value, target, root, path, issues, nextStack);
  }
  if ('const' in schema && canonicalJson(value) !== canonicalJson(schema['const'])) {
    issues.push({ path, message: `expected constant ${JSON.stringify(schema['const'])}` });
    return;
  }
  if (Array.isArray(schema['enum'])) {
    const serialized = canonicalJson(value);
    if (!schema['enum'].some((candidate) => canonicalJson(candidate) === serialized)) {
      issues.push({ path, message: `value must be one of ${JSON.stringify(schema['enum'])}` });
      return;
    }
  }
  if (Array.isArray(schema['anyOf'])) {
    const ok = schema['anyOf'].some((branch) => {
      if (!isSubschema(branch)) return false;
      const branchIssues: JsonSchemaValidationIssue[] = [];
      validateNode(value, branch, root, path, branchIssues, refStack);
      return branchIssues.length === 0;
    });
    if (!ok) issues.push({ path, message: 'value did not match anyOf schema' });
  }
  if (Array.isArray(schema['oneOf'])) {
    let matches = 0;
    for (const branch of schema['oneOf']) {
      if (!isSubschema(branch)) continue;
      const branchIssues: JsonSchemaValidationIssue[] = [];
      validateNode(value, branch, root, path, branchIssues, refStack);
      if (branchIssues.length === 0) matches += 1;
    }
    if (matches !== 1) issues.push({ path, message: `value matched ${matches} oneOf branches (expected 1)` });
  }
  if (Array.isArray(schema['allOf'])) {
    for (const branch of schema['allOf']) {
      if (isSubschema(branch)) {
        validateNode(value, branch, root, path, issues, refStack);
      }
    }
  }
  if (isSubschema(schema['not'])) {
    const notIssues: JsonSchemaValidationIssue[] = [];
    validateNode(value, schema['not'], root, path, notIssues, refStack);
    if (notIssues.length === 0) {
      issues.push({ path, message: 'value must not match negated schema' });
    }
  }

  const schemaType = schema['type'];
  if (typeof schemaType === 'string') {
    if (!matchesType(value, schemaType)) {
      issues.push({ path, message: `expected ${schemaType}, got ${typeOfJson(value)}` });
      return;
    }
  } else if (Array.isArray(schemaType)) {
    const allowed = schemaType.filter((item): item is string => typeof item === 'string');
    if (allowed.length > 0 && !allowed.some((candidate) => matchesType(value, candidate))) {
      issues.push({ path, message: `expected ${allowed.join('|')}, got ${typeOfJson(value)}` });
      return;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      issues.push({ path, message: `string shorter than minLength ${schema['minLength']}` });
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      issues.push({ path, message: `string longer than maxLength ${schema['maxLength']}` });
    }
    if (typeof schema['pattern'] === 'string') {
      try {
        if (!new RegExp(schema['pattern']).test(value)) {
          issues.push({ path, message: `string does not match pattern ${schema['pattern']}` });
        }
      } catch {
        issues.push({ path, message: `invalid schema regex pattern ${schema['pattern']}` });
      }
    }
    return;
  }

  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      issues.push({ path, message: `number less than minimum ${schema['minimum']}` });
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      issues.push({ path, message: `number greater than maximum ${schema['maximum']}` });
    }
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) {
      issues.push({ path, message: `number must be > ${schema['exclusiveMinimum']}` });
    }
    if (typeof schema['exclusiveMaximum'] === 'number' && value >= schema['exclusiveMaximum']) {
      issues.push({ path, message: `number must be < ${schema['exclusiveMaximum']}` });
    }
    if (typeof schema['multipleOf'] === 'number' && schema['multipleOf'] > 0) {
      const quotient = value / schema['multipleOf'];
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        issues.push({ path, message: `number must be a multiple of ${schema['multipleOf']}` });
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) {
      issues.push({ path, message: `array shorter than minItems ${schema['minItems']}` });
    }
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      issues.push({ path, message: `array longer than maxItems ${schema['maxItems']}` });
    }
    if (schema['uniqueItems'] === true) {
      const seenItems = new Set<string>();
      for (let i = 0; i < value.length; i += 1) {
        const key = canonicalJson(value[i]);
        if (seenItems.has(key)) {
          issues.push({ path: `${path}[${i}]`, message: 'array items must be unique' });
        } else {
          seenItems.add(key);
        }
      }
    }
    const prefixItems = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : undefined;
    if (prefixItems !== undefined) {
      for (let i = 0; i < Math.min(value.length, prefixItems.length); i += 1) {
        const prefixSchema = prefixItems[i];
        if (isSubschema(prefixSchema)) {
          validateNode(value[i], prefixSchema, root, `${path}[${i}]`, issues, refStack);
        }
      }
    }
    const items = schema['items'];
    const startIdx = prefixItems === undefined ? 0 : prefixItems.length;
    if (items === false && value.length > startIdx) {
      issues.push({ path: `${path}[${startIdx}]`, message: 'additional array items not allowed' });
    } else if (isSubschema(items)) {
      for (let i = startIdx; i < value.length; i += 1) {
        validateNode(value[i], items, root, `${path}[${i}]`, issues, refStack);
      }
    } else if (Array.isArray(items)) {
      for (let i = 0; i < Math.min(value.length, items.length); i += 1) {
        const itemSchema = items[i];
        if (isSubschema(itemSchema)) {
          validateNode(value[i], itemSchema, root, `${path}[${i}]`, issues, refStack);
        }
      }
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (typeof schema['minProperties'] === 'number' && keys.length < schema['minProperties']) {
      issues.push({ path, message: `object has fewer than minProperties ${schema['minProperties']}` });
    }
    if (typeof schema['maxProperties'] === 'number' && keys.length > schema['maxProperties']) {
      issues.push({ path, message: `object has more than maxProperties ${schema['maxProperties']}` });
    }
    const required = Array.isArray(schema['required'])
      ? schema['required'].filter((key): key is string => typeof key === 'string')
      : [];
    for (const key of required) {
      if (!Object.hasOwn(record, key)) {
        issues.push({ path: path ? `${path}.${key}` : key, message: 'missing required property' });
      }
    }
    const properties = typeof schema['properties'] === 'object' && schema['properties'] !== null && !Array.isArray(schema['properties'])
      ? (schema['properties'] as Record<string, unknown>)
      : undefined;
    const additional = schema['additionalProperties'];
    const propertyNames = schema['propertyNames'];
    for (const [key, propValue] of Object.entries(record)) {
      const propPath = path ? `${path}.${key}` : key;
      if (isSubschema(propertyNames)) {
        validateNode(key, propertyNames, root, propPath, issues, refStack);
      }
      if (properties !== undefined && Object.hasOwn(properties, key)) {
        const propSchema = properties[key];
        if (isSubschema(propSchema)) {
          validateNode(propValue, propSchema, root, propPath, issues, refStack);
        }
      } else if (additional === false) {
        issues.push({ path: propPath, message: 'additional property not allowed' });
      } else if (isSubschema(additional)) {
        validateNode(propValue, additional, root, propPath, issues, refStack);
      }
    }
  }
}

export function validateJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
): readonly JsonSchemaValidationIssue[] {
  const schemaIssues = validateSupportedOutputSchema(schema);
  if (schemaIssues.length > 0) return schemaIssues;
  const issues: JsonSchemaValidationIssue[] = [];
  validateNode(value, schema, schema, '', issues, new Set());
  return issues;
}

export function parseAndValidateStructuredOutput(
  text: string,
  schema: Record<string, unknown>,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  const schemaIssues = validateSupportedOutputSchema(schema);
  if (schemaIssues.length > 0) {
    return {
      ok: false,
      error: `Unsupported output_schema: ${schemaIssues.map((i) => `${i.path || '$'}: ${i.message}`).join('; ')}`,
    };
  }
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  const candidate = fenced === null ? trimmed : fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, error: `Output is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const issues = validateJsonSchemaValue(parsed, schema);
  if (issues.length > 0) {
    return {
      ok: false,
      error: `Output failed output_schema validation: ${issues.map((i) => `${i.path || '$'}: ${i.message}`).join('; ')}`,
    };
  }
  return { ok: true, value: parsed };
}
