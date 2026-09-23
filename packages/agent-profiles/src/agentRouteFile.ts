import type {
  AgentProfileRouteDefinition,
  AgentProfileRoutePromptMode,
  RequestParams,
  ServiceTier,
} from './agentProfile';
import { AgentFileParseError } from './agentFile';
import { FrontmatterError, parseFrontmatter } from './frontmatter';

const ROUTE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set([
  'id',
  'profile',
  'description',
  'whenToUse',
  'prompt_mode',
  'model_preference',
  'model_alias',
  'thinking_effort',
  'service_tier',
  'request_params',
  'tools',
  'disallowedTools',
  'subagents',
]);

export interface ParseAgentRouteFileOptions {
  readonly path: string;
  readonly expectedProfile: string;
  readonly expectedRouteName: string;
  readonly text: string;
  readonly warn?: (message: string) => void;
}

export function parseAgentRouteFileText(
  options: ParseAgentRouteFileOptions,
): AgentProfileRouteDefinition {
  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw invalid(options.path, `Invalid frontmatter: ${error.message}`, error);
    }
    throw error;
  }
  if (!isRecord(parsed.data)) {
    throw invalid(options.path, 'Frontmatter must be a mapping at the top level');
  }
  for (const key of Object.keys(parsed.data)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw invalid(options.path, `Unknown frontmatter field "${key}"`);
    }
  }

  const id = requiredString(parsed.data['id'], 'id', options.path);
  if (!ROUTE_ID_PATTERN.test(id)) {
    throw invalid(
      options.path,
      `Invalid route id "${id}": expected lowercase kebab-case dotted segments`,
    );
  }
  const profile = requiredString(parsed.data['profile'], 'profile', options.path);
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw invalid(options.path, `Invalid base profile "${profile}": expected kebab-case`);
  }
  const idProfile = id.slice(0, id.indexOf('.'));
  const routeName = id.slice(id.indexOf('.') + 1);
  if (profile !== idProfile || profile !== options.expectedProfile) {
    throw invalid(
      options.path,
      `Route id "${id}" and profile "${profile}" must match directory "${options.expectedProfile}"`,
    );
  }
  if (routeName !== options.expectedRouteName) {
    throw invalid(
      options.path,
      `Route id "${id}" must match sidecar name "${options.expectedRouteName}.md"`,
    );
  }

  const description = requiredString(parsed.data['description'], 'description', options.path);
  const promptMode = parsePromptMode(parsed.data['prompt_mode'], options.path);
  const prompt = parsed.body.trim();
  validatePrompt(promptMode, prompt, options.path);

  const rawTools = parseStringList(parsed.data['tools'], 'tools', options.path);
  const tools = rawTools?.length === 1 && rawTools[0] === '*' ? undefined : rawTools;
  const disallowedTools = parseStringList(
    parsed.data['disallowedTools'],
    'disallowedTools',
    options.path,
  );
  const rawSubagents = parseStringList(parsed.data['subagents'], 'subagents', options.path);
  const subagents =
    rawSubagents?.length === 1 && rawSubagents[0] === '*' ? undefined : rawSubagents;
  rejectModelPreference(parsed.data['model_preference'], options.path);
  const modelAlias = optionalString(parsed.data['model_alias'], 'model_alias', options.path);
  const thinkingEffort = optionalString(
    parsed.data['thinking_effort'],
    'thinking_effort',
    options.path,
  );
  const serviceTier = parseServiceTier(parsed.data['service_tier'], options.path);
  let requestParams = parseRequestParams(parsed.data['request_params'], options.path);
  if (
    serviceTier !== undefined &&
    requestParams !== undefined &&
    requestParams !== null &&
    Object.hasOwn(requestParams, 'service_tier')
  ) {
    options.warn?.(
      `Frontmatter field "service_tier" in ${options.path} overrides request_params.service_tier; ignoring the nested value`,
    );
    const next = { ...requestParams };
    delete next['service_tier'];
    requestParams = next;
  }

  return {
    id,
    profile,
    description,
    whenToUse: optionalString(parsed.data['whenToUse'], 'whenToUse', options.path),
    promptMode,
    prompt,
    tools,
    disallowedTools,
    subagents,
    modelAlias,
    thinkingEffort,
    serviceTier,
    requestParams,
    overriddenFields: [
      'model_alias',
      'thinking_effort',
      'service_tier',
      'request_params',
      'tools',
      'disallowedTools',
      'subagents',
      'prompt_mode',
    ].filter((key) => Object.hasOwn(parsed.data!, key)),
    path: options.path,
  };
}

function countParentPromptTokens(prompt: string): number {
  return (
    prompt.split('${base_prompt}').length -
    1 +
    (prompt.split('${parent_prompt}').length - 1)
  );
}

function validatePrompt(mode: AgentProfileRoutePromptMode, prompt: string, path: string): void {
  const count = countParentPromptTokens(prompt);
  if (mode === 'inherit') {
    if (prompt.length !== 0) throw invalid(path, 'prompt_mode "inherit" requires an empty body');
    return;
  }
  if (prompt.length === 0) throw invalid(path, `prompt_mode "${mode}" requires a body`);
  if (mode === 'wrap') {
    if (count !== 1) {
      throw invalid(
        path,
        'prompt_mode "wrap" requires ${parent_prompt} (or ${base_prompt}) exactly once',
      );
    }
    return;
  }
  if (count !== 0) {
    throw invalid(
      path,
      `prompt_mode "${mode}" does not allow \${parent_prompt} or \${base_prompt} in the body`,
    );
  }
}

function parsePromptMode(value: unknown, path: string): AgentProfileRoutePromptMode {
  if (value === 'inherit' || value === 'prepend' || value === 'append' || value === 'wrap') {
    return value;
  }
  throw invalid(path, 'Frontmatter field "prompt_mode" must be inherit, prepend, append, or wrap');
}

function rejectModelPreference(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  throw invalid(
    path,
    'Frontmatter field "model_preference" has been removed. Use "model_alias: inherit" to explicitly follow the caller, or set "model_alias" to an exact [models] alias.',
  );
}

function parseServiceTier(value: unknown, path: string): ServiceTier | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === 'auto' || value === 'default' || value === 'flex' || value === 'priority') {
    return value;
  }
  throw invalid(path, 'Frontmatter field "service_tier" has an invalid value');
}

function parseRequestParams(value: unknown, path: string): RequestParams | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainRecord(value)) {
    throw invalid(path, 'Frontmatter field "request_params" must be null or a scalar mapping');
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw invalid(path, `Frontmatter field "request_params.${key}" must be scalar`);
    }
    Object.defineProperty(out, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function parseStringList(value: unknown, field: string, path: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) throw invalid(path, `Frontmatter field "${field}" must be a string or list`);
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw invalid(path, `Frontmatter field "${field}" must contain non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function requiredString(value: unknown, field: string, path: string): string {
  const result = optionalString(value, field, path);
  if (result === undefined) throw invalid(path, `Missing required frontmatter field "${field}"`);
  return result;
}

function optionalString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(path, `Frontmatter field "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function invalid(path: string, message: string, cause?: unknown): AgentFileParseError {
  return new AgentFileParseError(`Invalid agent route sidecar ${path}: ${message}`, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
