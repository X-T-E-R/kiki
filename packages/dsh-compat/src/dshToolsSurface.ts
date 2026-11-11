import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z as zod } from 'zod';

import type { ContentBlock } from './vendor/llm/src/types';
import type { JsonSchemaNode, JsonSchemaScalar, JsonSchemaType } from './vendor/tools/src/json-schema';
import {
  assertSupportedJsonSchema,
  isJsonSchemaRecord,
  isPlainJsonArray,
  JsonSchemaError,
  validateJsonSchemaValue,
} from './vendor/tools/src/json-schema';
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ValueSchemaSpec,
} from './vendor/tools/src/schema';
import {
  defineTool as defineUpstreamTool,
  parameterSchemaSpecToJsonSchema,
  ToolArgsError,
  validateArgs,
  valueSchemaSpecToJsonSchema,
} from './vendor/tools/src/schema';
import type { ToolDefinition, ToolResult, ToolRunContext } from './vendor/tools/src/index';
import type { ToolCallView, ToolResultView } from './vendor/tools/src/presentation';
import { deepFreeze, type JsonValue } from './vendor/util-values/src/index';

export * from './vendor/tools/src/index';
export * from './vendor/tools/src/json-schema';
export * from './vendor/tools/src/presentation';
export {
  parameterSchemaSpecToJsonSchema,
  ToolArgsError,
  validateArgs,
  valueSchemaSpecToJsonSchema,
  type ArrayValueSchemaSpec,
  type BooleanValueSchemaSpec,
  type DefineToolOptions,
  type InferArgs,
  type InferValue,
  type IntegerValueSchemaSpec,
  type JsonValueSchemaSpec,
  type NullValueSchemaSpec,
  type NumberValueSchemaSpec,
  type ObjectValueSchemaSpec,
  type OneOfValueSchemaSpec,
  type ParameterJsonSchema,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type StringValueSchemaSpec,
  type ValueSchemaAnnotations,
  type ValueSchemaSpec,
} from './vendor/tools/src/schema';

/** Options for defining a DSH-compatible tool backed by StandardSchemaV1 (Zod v4 or Schemastery). */
export interface DefineStandardSchemaToolOptions<
  TSchema extends StandardSchemaV1,
  TOutput extends ValueSchemaSpec | StandardSchemaV1 = ValueSchemaSpec,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly output: {
    readonly schema: TOutput;
    render(
      args: StandardSchemaV1.InferOutput<TSchema>,
      value: TOutput extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TOutput> : unknown,
    ): ContentBlock[];
    presentationMeta?(
      args: StandardSchemaV1.InferOutput<TSchema>,
      value: TOutput extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TOutput> : unknown,
    ): JsonValue;
  };
  readonly deferLoading?: true;
  readonly timeoutMs?: number;
  isConcurrencySafe?(args: StandardSchemaV1.InferOutput<TSchema>): boolean;
  execute(
    args: StandardSchemaV1.InferOutput<TSchema>,
    exec: ToolRunContext,
  ): Promise<TOutput extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<TOutput> : JsonValue>;
  projectContent?: ToolDefinition['projectContent'];
  finalizeContent?: ToolDefinition['finalizeContent'];
  presentCall?(args: StandardSchemaV1.InferOutput<TSchema>): ToolCallView | undefined;
  presentResult?(args: StandardSchemaV1.InferOutput<TSchema>, result: ToolResult): ToolResultView | undefined;
}

function isStandardSchema(candidate: unknown): candidate is StandardSchemaV1 {
  return (
    (typeof candidate === 'object' || typeof candidate === 'function')
    && candidate !== null
    && '~standard' in candidate
  );
}

function sanitizeJsonSchemaNode(raw: unknown): JsonSchemaNode {
  if (!isJsonSchemaRecord(raw)) return {};
  const out: JsonSchemaNode = {};
  if (typeof raw['description'] === 'string') out.description = raw['description'];
  if (typeof raw['title'] === 'string') out.title = raw['title'];
  const anyOf = raw['oneOf'] ?? raw['anyOf'];
  if (isPlainJsonArray(anyOf) && anyOf.length >= 2) {
    out.oneOf = anyOf.map(branch => sanitizeJsonSchemaNode(branch));
    return out;
  }
  const rawType = raw['type'];
  if (Array.isArray(rawType)) {
    const branches = rawType
      .filter((entry): entry is JsonSchemaType => typeof entry === 'string')
      .map((entry): JsonSchemaNode => ({ type: entry }));
    if (branches.length >= 2) {
      out.oneOf = branches;
      return out;
    }
    if (branches.length === 1 && branches[0]?.type !== undefined) {
      out.type = branches[0].type;
    }
  } else if (
    rawType === 'object'
    || rawType === 'array'
    || rawType === 'string'
    || rawType === 'number'
    || rawType === 'integer'
    || rawType === 'boolean'
    || rawType === 'null'
  ) {
    out.type = rawType;
  }
  if (out.type === 'object') {
    if (isJsonSchemaRecord(raw['properties'])) {
      const props: Record<string, JsonSchemaNode> = {};
      for (const [key, child] of Object.entries(raw['properties'])) {
        props[key] = sanitizeJsonSchemaNode(child);
      }
      out.properties = props;
    }
    if (isPlainJsonArray(raw['required'])) {
      const req = raw['required'].filter((item): item is string => typeof item === 'string');
      if (req.length > 0) out.required = req;
    }
    if (typeof raw['additionalProperties'] === 'boolean') {
      out.additionalProperties = raw['additionalProperties'];
    }
  } else if (out.type === 'array') {
    if (raw['items'] !== undefined) {
      out.items = sanitizeJsonSchemaNode(raw['items']);
    }
  } else if (out.type !== undefined) {
    if (isPlainJsonArray(raw['enum']) && raw['enum'].length > 0) {
      out.enum = raw['enum'] as JsonSchemaScalar[];
    }
    if (Object.hasOwn(raw, 'const')) {
      out.const = raw['const'] as JsonSchemaScalar;
    }
  }
  return out;
}

function schemasteryRefToJsonSchema(
  uid: number,
  refs: Record<string, Record<string, unknown>>,
  seen: Set<number>,
): JsonSchemaNode {
  if (seen.has(uid)) return {};
  const node = refs[String(uid)];
  if (!node) return {};
  seen.add(uid);
  try {
    const type = node['type'];
    const meta = isJsonSchemaRecord(node['meta']) ? node['meta'] : {};
    const description = typeof meta['description'] === 'string' ? { description: meta['description'] } : {};
    if (type === 'string') return { type: 'string', ...description };
    if (type === 'number' || type === 'natural') return { type: 'number', ...description };
    if (type === 'boolean') return { type: 'boolean', ...description };
    if (type === 'const') {
      const val = node['value'];
      if (typeof val === 'string') return { type: 'string', const: val, ...description };
      if (typeof val === 'number') return { type: 'number', const: val, ...description };
      if (typeof val === 'boolean') return { type: 'boolean', const: val, ...description };
      if (val === null) return { type: 'null', const: null, ...description };
      return { ...description };
    }
    if (type === 'array' || type === 'tuple') {
      const inner = typeof node['inner'] === 'number'
        ? schemasteryRefToJsonSchema(node['inner'], refs, seen)
        : undefined;
      return { type: 'array', ...(inner === undefined ? {} : { items: inner }), ...description };
    }
    if (type === 'object') {
      const dict = isJsonSchemaRecord(node['dict']) ? node['dict'] : {};
      const properties: Record<string, JsonSchemaNode> = {};
      const required: string[] = [];
      for (const [key, childUid] of Object.entries(dict)) {
        if (typeof childUid !== 'number') continue;
        properties[key] = schemasteryRefToJsonSchema(childUid, refs, seen);
        const childNode = refs[String(childUid)];
        const childMeta = childNode && isJsonSchemaRecord(childNode['meta']) ? childNode['meta'] : undefined;
        if (childMeta?.['required'] === true) required.push(key);
      }
      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        ...description,
      };
    }
    if (type === 'dict') {
      return { type: 'object', ...description };
    }
    if (type === 'union' && Array.isArray(node['list'])) {
      const branches = (node['list'] as unknown[])
        .filter((id): id is number => typeof id === 'number')
        .map(id => schemasteryRefToJsonSchema(id, refs, seen));
      if (branches.length >= 2) return { oneOf: branches, ...description };
      if (branches.length === 1 && branches[0]) return { ...branches[0], ...description };
    }
    return { ...description };
  } finally {
    seen.delete(uid);
  }
}

/** Convert a Zod v4, Schemastery, or StandardSchemaV1 schema into DSH's enforced JSON Schema subset. */
export function standardSchemaToJsonSchema(schema: StandardSchemaV1): JsonSchemaNode {
  const std = schema['~standard'];
  if ('_zod' in (schema as object)) {
    const converted = JSON.parse(JSON.stringify(zod.toJSONSchema(schema as unknown as zod.ZodType))) as unknown;
    const sanitized = sanitizeJsonSchemaNode(converted);
    assertSupportedJsonSchema(sanitized);
    return sanitized;
  }
  const stdWithJson = std as unknown as {
    jsonSchema?: { input?: (opts: { target: string }) => Record<string, unknown> };
  };
  if (typeof stdWithJson.jsonSchema?.input === 'function') {
    const raw = JSON.parse(JSON.stringify(stdWithJson.jsonSchema.input({ target: 'draft-2020-12' }))) as unknown;
    const sanitized = sanitizeJsonSchemaNode(raw);
    assertSupportedJsonSchema(sanitized);
    return sanitized;
  }
  const maybeSchemastery = schema as unknown as { toJSON?: () => unknown };
  if (typeof maybeSchemastery.toJSON === 'function') {
    const dumped = maybeSchemastery.toJSON();
    if (
      isJsonSchemaRecord(dumped)
      && typeof dumped['uid'] === 'number'
      && isJsonSchemaRecord(dumped['refs'])
    ) {
      const node = schemasteryRefToJsonSchema(
        dumped['uid'],
        dumped['refs'] as Record<string, Record<string, unknown>>,
        new Set(),
      );
      assertSupportedJsonSchema(node);
      return node;
    }
  }
  return { type: 'object', properties: {} };
}

function validateStandardSchemaSync<T>(schema: StandardSchemaV1<unknown, T>, input: unknown): {
  readonly ok: true;
  readonly value: T;
} | {
  readonly ok: false;
  readonly violations: string[];
} {
  const outcome = schema['~standard'].validate(input);
  if ('then' in outcome) {
    return { ok: false, violations: ['async parameter validation is not supported in synchronous tool schema gate'] };
  }
  if (outcome.issues !== undefined) {
    return {
      ok: false,
      violations: outcome.issues.map((issue) => {
        const path = issue.path?.map(part => (typeof part === 'object' && part !== null && 'key' in part ? String(part.key) : String(part))).join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }
  return { ok: true, value: outcome.value };
}

/**
 * Define a DSH tool using either upstream's declarative `ParameterSchemaSpec`
 * or any `StandardSchemaV1` validator (Zod v4 / Schemastery).
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition;
export function defineTool<
  TSchema extends StandardSchemaV1,
  TOutput extends ValueSchemaSpec | StandardSchemaV1 = ValueSchemaSpec,
>(options: DefineStandardSchemaToolOptions<TSchema, TOutput>): ToolDefinition;
export function defineTool(options: DefineToolOptions<any, any> | DefineStandardSchemaToolOptions<any, any>): ToolDefinition {
  if (!isStandardSchema(options.parameters)) {
    return (defineUpstreamTool as (opts: unknown) => ToolDefinition)(options);
  }
  const stdOptions = options as DefineStandardSchemaToolOptions<StandardSchemaV1, ValueSchemaSpec | StandardSchemaV1>;
  if (stdOptions.timeoutMs !== undefined && (!Number.isFinite(stdOptions.timeoutMs) || stdOptions.timeoutMs <= 0)) {
    throw new Error(`defineTool(${stdOptions.name}): timeoutMs must be a positive finite number`);
  }
  const parametersNode = standardSchemaToJsonSchema(stdOptions.parameters);
  if (parametersNode.type !== 'object') {
    throw new JsonSchemaError(['tool parameters StandardSchema must compile to an object root']);
  }
  const outputSchemaNode = isStandardSchema(stdOptions.output.schema)
    ? standardSchemaToJsonSchema(stdOptions.output.schema)
    : valueSchemaSpecToJsonSchema(stdOptions.output.schema);
  const userExecute = stdOptions.execute.bind(stdOptions);
  const userRender = stdOptions.output.render.bind(stdOptions.output);
  const userPresentationMeta = stdOptions.output.presentationMeta?.bind(stdOptions.output);

  const tool: ToolDefinition = {
    name: stdOptions.name,
    description: stdOptions.description,
    parameters: parametersNode as unknown as Record<string, unknown>,
    output: {
      schema: outputSchemaNode,
      render(args: unknown, value: JsonValue): ContentBlock[] {
        const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
        return userRender(parsed.ok ? parsed.value : args, value);
      },
      ...(userPresentationMeta === undefined
        ? {}
        : {
            presentationMeta(args: unknown, value: JsonValue): JsonValue {
              const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
              return userPresentationMeta(parsed.ok ? parsed.value : args, value);
            },
          }),
    },
    ...(stdOptions.deferLoading === true ? { deferLoading: true } : {}),
    ...(stdOptions.timeoutMs === undefined ? {} : { timeoutMs: stdOptions.timeoutMs }),
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
      if (!parsed.ok) throw new ToolArgsError(parsed.violations);
      const frozenArgs = deepFreeze(parsed.value as JsonValue);
      const rawOutput = await userExecute(frozenArgs, exec);
      if (isStandardSchema(stdOptions.output.schema)) {
        const outParsed = validateStandardSchemaSync(stdOptions.output.schema, rawOutput);
        if (!outParsed.ok) throw new ToolArgsError(outParsed.violations);
        return outParsed.value as JsonValue;
      }
      const violations = validateJsonSchemaValue(outputSchemaNode, rawOutput);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return rawOutput as JsonValue;
    },
  };
  if (stdOptions.projectContent !== undefined) tool.projectContent = stdOptions.projectContent;
  if (stdOptions.finalizeContent !== undefined) tool.finalizeContent = stdOptions.finalizeContent;
  if (stdOptions.presentCall !== undefined) {
    const presentCall = stdOptions.presentCall.bind(stdOptions);
    tool.presentCall = (args: unknown) => {
      const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
      return parsed.ok ? presentCall(parsed.value) : undefined;
    };
  }
  if (stdOptions.presentResult !== undefined) {
    const presentResult = stdOptions.presentResult.bind(stdOptions);
    tool.presentResult = (args: unknown, result: ToolResult) => {
      const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
      return parsed.ok ? presentResult(parsed.value, result) : undefined;
    };
  }
  if (stdOptions.isConcurrencySafe !== undefined) {
    const isConcurrencySafe = stdOptions.isConcurrencySafe.bind(stdOptions);
    tool.isConcurrencySafe = (args: unknown) => {
      const parsed = validateStandardSchemaSync(stdOptions.parameters, args);
      return parsed.ok ? isConcurrencySafe(parsed.value) : false;
    };
  }
  return tool;
}
