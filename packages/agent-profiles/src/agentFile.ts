import { dirname } from 'pathe';

import { AgentSystemPromptModeSchema } from './agentProfile';
import type { AgentFileDefinition, AgentFileSource } from './agentFileTypes';
import { FrontmatterError, parseFrontmatter } from './frontmatter';
import { openIfEmpty, parseSpawnConstraints, parseSubagentList, SubagentLeaseParseError } from './subagentLease';

export class AgentFileParseError extends Error {
  readonly code = 'validation.failed';
  readonly reason?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AgentFileParseError';
    if (cause !== undefined) this.reason = cause;
  }
}

export interface ParseAgentFileOptions {
  readonly path: string;
  readonly source: AgentFileSource;
  readonly text: string;
  readonly definitionId?: string;
  readonly contributionRoot?: string;
  readonly sourceProfile?: boolean;
  readonly warn?: (message: string) => void;
  readonly fallbackDescription?: string;
  readonly forceName?: string;
  readonly forceOverride?: boolean;
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const AGENT_FILE_KEYS = new Set([
  'name',
  'description',
  'override',
  'main',
  'private',
  'delegation_notice',
  'tools',
  'disallowedTools',
  'subagents',
  'spawn_constraints',
  'executor',
  'executor_options',
  'model_alias',
  'thinking_effort',
  'allowed_models',
  'deny_models',
  'allowed_efforts',
  'model_profiles',
  'recommended_models',
  'service_tier',
  'request_params',
  'context_budget',
  'max_completion_tokens',
  'system_prompt_mode',
  'model_preference',
  'whenToUse',
]);

export function parseAgentFileText(options: ParseAgentFileOptions): AgentFileDefinition {
  let parsed;
  try {
    parsed = parseFrontmatter(options.text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw new AgentFileParseError(
        `Invalid frontmatter in ${options.path}: ${error.message}`,
        error,
      );
    }
    throw error;
  }

  const frontmatter = parsed.data;
  if (frontmatter === null) {
    throw new AgentFileParseError(`Missing frontmatter in ${options.path}`);
  }
  if (!isRecord(frontmatter)) {
    throw new AgentFileParseError(
      `Frontmatter in ${options.path} must be a mapping at the top level`,
    );
  }
  for (const key of Object.keys(frontmatter)) {
    if (!AGENT_FILE_KEYS.has(key)) {
      throw new AgentFileParseError(
        `Unknown frontmatter field "${key}" in ${options.path}; remove or migrate unsupported keys before loading this closed-key profile`,
      );
    }
  }
  if (
    options.sourceProfile === true &&
    (Object.hasOwn(frontmatter, 'main') || Object.hasOwn(frontmatter, 'override'))
  ) {
    throw new AgentFileParseError(
      `Scoped source profile ${options.path} cannot declare "main" or "override"`,
    );
  }

  const nameField = frontmatter['name'];
  if (nameField !== undefined && nameField !== null && typeof nameField !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "name" in ${options.path} must be a non-empty string`,
    );
  }
  const name =
    options.forceName ?? nonEmptyString(nameField) ?? deriveNameFromPath(options.path);
  if (name === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "name" in ${options.path}`);
  }
  if (options.forceName === undefined && !AGENT_NAME_PATTERN.test(name)) {
    throw new AgentFileParseError(
      `Invalid agent name "${name}" in ${options.path}: expected kebab-case (e.g. "code-reviewer")`,
    );
  }

  if (
    frontmatter['description'] !== undefined &&
    frontmatter['description'] !== null &&
    typeof frontmatter['description'] !== 'string'
  ) {
    throw new AgentFileParseError(
      `Frontmatter field "description" in ${options.path} must be a non-empty string`,
    );
  }
  const description =
    nonEmptyString(frontmatter['description']) ?? options.fallbackDescription;
  if (description === undefined) {
    throw new AgentFileParseError(
      `Missing required frontmatter field "description" in ${options.path}`,
    );
  }

  const override =
    options.forceOverride === true
      ? true
      : parseBoolean(frontmatter['override'], 'override', options.path);
  const main = parseBoolean(frontmatter['main'], 'main', options.path);
  const privateProfile = parseBoolean(frontmatter['private'], 'private', options.path);
  const delegationNotice = parseDelegationNotice(
    frontmatter['delegation_notice'],
    options.path,
  );
  const rawTools = parseStringList(frontmatter['tools'], 'tools', options.path);
  const tools = rawTools?.length === 1 && rawTools[0] === '*' ? undefined : rawTools;
  const disallowedTools = parseStringList(
    frontmatter['disallowedTools'],
    'disallowedTools',
    options.path,
  );
  let parsedSubagents;
  let spawnConstraints;
  try {
    parsedSubagents = parseSubagentList(frontmatter['subagents'], options.path);
    spawnConstraints = parseSpawnConstraints(frontmatter['spawn_constraints'], options.path);
  } catch (error) {
    if (error instanceof SubagentLeaseParseError) {
      throw new AgentFileParseError(error.message, error);
    }
    throw error;
  }
  const subagents = parsedSubagents.subagents;
  const subagentLeases = parsedSubagents.subagentLeases;
  const executor = optionalNonEmptyStringField(
    frontmatter['executor'],
    'executor',
    options.path,
  );
  const executorOptions = parseExecutorOptions(
    frontmatter['executor_options'],
    options.path,
  );
  if (executorOptions !== undefined && executor === undefined) {
    throw new AgentFileParseError(
      `Frontmatter field "executor" in ${options.path} is required when executor_options is set`,
    );
  }
  if (main && executor !== undefined && executor !== 'native') {
    throw new AgentFileParseError(
      `External executor "${executor}" is unsupported for main agent profile ${options.path}`,
    );
  }
  rejectModelPreference(frontmatter['model_preference'], options.path);
  const modelAlias = optionalNonEmptyStringField(
    frontmatter['model_alias'],
    'model_alias',
    options.path,
  );
  const thinkingEffort = optionalNonEmptyStringField(
    frontmatter['thinking_effort'],
    'thinking_effort',
    options.path,
  );
  const allowedModels = openIfEmpty(
    parseStringList(frontmatter['allowed_models'], 'allowed_models', options.path),
  );
  const denyModels = openIfEmpty(parseStringList(frontmatter['deny_models'], 'deny_models', options.path));
  const allowedEfforts = openIfEmpty(
    parseStringList(frontmatter['allowed_efforts'], 'allowed_efforts', options.path),
  );
  warnIncoherentModelConstraints(
    modelAlias,
    allowedModels,
    denyModels,
    options.path,
    options.warn,
  );
  const modelProfiles = resolveModelProfiles(frontmatter, options.path, options.warn);
  const serviceTier = parseServiceTier(frontmatter['service_tier'], options.path);
  let requestParams = parseRequestParams(frontmatter['request_params'], options.path);
  if (
    serviceTier !== undefined &&
    requestParams !== undefined &&
    Object.hasOwn(requestParams, 'service_tier')
  ) {
    options.warn?.(
      `Frontmatter field "service_tier" in ${options.path} overrides request_params.service_tier; ignoring the nested value`,
    );
    const withoutServiceTier: Record<string, string | number | boolean> = {
      ...requestParams,
    };
    delete withoutServiceTier['service_tier'];
    requestParams = withoutServiceTier;
  }
  const systemPromptModeValue = frontmatter['system_prompt_mode'];
  const systemPromptMode =
    systemPromptModeValue === undefined || systemPromptModeValue === null
      ? undefined
      : AgentSystemPromptModeSchema.safeParse(systemPromptModeValue);
  if (systemPromptMode !== undefined && !systemPromptMode.success) {
    throw new AgentFileParseError(
      `Frontmatter field "system_prompt_mode" in ${options.path} must be replace, prepend, or append`,
    );
  }
  const prompt = parsed.body.trim();
  if (prompt.length === 0) {
    throw new AgentFileParseError(`Missing prompt body in ${options.path}`);
  }
  const resolvedSystemPromptMode = systemPromptMode?.data;
  if (
    resolvedSystemPromptMode !== undefined &&
    resolvedSystemPromptMode !== 'replace' &&
    countParentPromptTokens(prompt) !== 0
  ) {
    throw new AgentFileParseError(
      `Prompt body in ${options.path} with system_prompt_mode "${resolvedSystemPromptMode}" does not allow \${parent_prompt} or \${base_prompt}`,
    );
  }

  return {
    name,
    definitionId: options.definitionId ?? options.path,
    contributionRoot: options.contributionRoot ?? dirname(options.path),
    private: privateProfile,
    description,
    whenToUse: nonEmptyString(frontmatter['whenToUse']),
    override,
    main: typeof frontmatter['main'] === 'boolean' ? main : undefined,
    tools,
    disallowedTools,
    subagents,
    subagentLeases,
    spawnConstraints,
    executor,
    executorOptions,
    modelAlias,
    thinkingEffort,
    allowedModels,
    denyModels,
    allowedEfforts,
    modelProfiles,
    serviceTier,
    requestParams,
    contextBudget: parseTokenBudget(frontmatter['context_budget'], 'context_budget', options.path),
    maxCompletionTokens: parseTokenBudget(frontmatter['max_completion_tokens'], 'max_completion_tokens', options.path),
    systemPromptMode: resolvedSystemPromptMode,
    prompt,
    path: options.path,
    source: options.source,
    ...(delegationNotice === undefined ? {} : { delegationNotice }),
  };
}

const MODEL_PROFILE_ENTRY_KEYS = new Set([
  'alias',
  'when',
  'thinking_effort',
  'prompt_mode',
  'prompt',
  'allowed_efforts',
  'service_tier',
  'request_params',
  'context_budget',
  'max_completion_tokens',
]);

function resolveModelProfiles(
  frontmatter: Record<string, unknown>,
  filePath: string,
  warn?: (message: string) => void,
): AgentFileDefinition['modelProfiles'] {
  const hasNew = Object.hasOwn(frontmatter, 'model_profiles');
  const hasOld = Object.hasOwn(frontmatter, 'recommended_models');
  if (hasNew && hasOld) {
    warn?.(
      `Frontmatter fields "model_profiles" and "recommended_models" in ${filePath} are both set; using "model_profiles"`,
    );
    return parseModelProfiles(frontmatter['model_profiles'], 'model_profiles', filePath);
  }
  if (hasNew) {
    return parseModelProfiles(frontmatter['model_profiles'], 'model_profiles', filePath);
  }
  if (hasOld) {
    warn?.(
      `Frontmatter field "recommended_models" in ${filePath} is deprecated; use "model_profiles"`,
    );
    return parseModelProfiles(frontmatter['recommended_models'], 'recommended_models', filePath);
  }
  return undefined;
}

function parseModelProfiles(
  value: unknown,
  field: string,
  filePath: string,
): AgentFileDefinition['modelProfiles'] {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a list of mappings`,
    );
  }
  const out: NonNullable<AgentFileDefinition['modelProfiles']>[number][] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new AgentFileParseError(
        `Frontmatter field "${field}[${index}]" in ${filePath} must be a mapping`,
      );
    }
    for (const key of Object.keys(item)) {
      if (!MODEL_PROFILE_ENTRY_KEYS.has(key)) {
        throw new AgentFileParseError(
          `Frontmatter field "${field}[${index}]" in ${filePath} contains unknown key "${key}"`,
        );
      }
    }
    const prefix = `${field}[${index}]`;
    const alias = requiredNonEmptyString(item['alias'], `${prefix}.alias`, filePath);
    const when = optionalNonEmptyStringField(item['when'], `${prefix}.when`, filePath);
    const thinkingEffort = optionalNonEmptyStringField(
      item['thinking_effort'],
      `${prefix}.thinking_effort`,
      filePath,
    );
    const promptMode = parseModelProfilePromptMode(item['prompt_mode'], `${prefix}.prompt_mode`, filePath);
    const prompt = optionalNonEmptyStringField(item['prompt'], `${prefix}.prompt`, filePath);
    if (promptMode !== undefined && prompt === undefined) {
      throw new AgentFileParseError(
        `Frontmatter field "${prefix}.prompt" in ${filePath} is required when prompt_mode is set`,
      );
    }
    if (prompt !== undefined && promptMode === undefined) {
      throw new AgentFileParseError(
        `Frontmatter field "${prefix}.prompt_mode" in ${filePath} is required when prompt is set`,
      );
    }
    if (promptMode !== undefined && prompt !== undefined) {
      validateModelProfilePrompt(promptMode, prompt, prefix, filePath);
    }
    const allowedEfforts = parseStringList(
      item['allowed_efforts'],
      `${prefix}.allowed_efforts`,
      filePath,
    );
    out.push({
      alias,
      when,
      thinkingEffort,
      promptMode,
      prompt,
      allowedEfforts,
      serviceTier: parseServiceTier(item['service_tier'], filePath),
      requestParams: parseRequestParams(item['request_params'], filePath),
      contextBudget: parseTokenBudget(item['context_budget'], `${prefix}.context_budget`, filePath),
      maxCompletionTokens: parseTokenBudget(item['max_completion_tokens'], `${prefix}.max_completion_tokens`, filePath),
    });
  }
  return out;
}

function parseTokenBudget(value: unknown, field: string, filePath: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new AgentFileParseError(`Frontmatter field "${field}" in ${filePath} must be a positive integer token budget`);
}

function parseModelProfilePromptMode(
  value: unknown,
  field: string,
  filePath: string,
): 'prepend' | 'append' | 'wrap' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'prepend' || value === 'append' || value === 'wrap') return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be "prepend", "append", or "wrap"`,
  );
}

function countParentPromptTokens(prompt: string): number {
  return prompt.split('${base_prompt}').length - 1 + (prompt.split('${parent_prompt}').length - 1);
}

function validateModelProfilePrompt(
  mode: 'prepend' | 'append' | 'wrap',
  prompt: string,
  prefix: string,
  filePath: string,
): void {
  const count = countParentPromptTokens(prompt);
  if (mode === 'wrap') {
    if (count !== 1) {
      throw new AgentFileParseError(
        `Frontmatter field "${prefix}.prompt" in ${filePath} with prompt_mode "wrap" requires \${parent_prompt} (or \${base_prompt}) exactly once`,
      );
    }
    return;
  }
  if (count !== 0) {
    throw new AgentFileParseError(
      `Frontmatter field "${prefix}.prompt" in ${filePath} with prompt_mode "${mode}" does not allow \${parent_prompt} or \${base_prompt}`,
    );
  }
}

function rejectModelPreference(value: unknown, filePath: string): void {
  if (value === undefined || value === null) return;
  throw new AgentFileParseError(
    `Frontmatter field "model_preference" in ${filePath} has been removed: subagents no longer inherit the caller's model. Set "model_alias" to an exact [models] alias instead.`,
  );
}

function parseServiceTier(value: unknown, filePath: string): AgentFileDefinition['serviceTier'] {
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'default' || value === 'flex' || value === 'priority') {
    return value;
  }
  throw new AgentFileParseError(
    `Frontmatter field "service_tier" in ${filePath} must be "auto", "default", "flex", or "priority"`,
  );
}

function parseExecutorOptions(
  value: unknown,
  filePath: string,
): AgentFileDefinition['executorOptions'] {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "executor_options" in ${filePath} must be a mapping of scalar string, number, or boolean values`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      throw new AgentFileParseError(
        `Frontmatter field "executor_options.${key}" in ${filePath} must be a scalar string, number, or boolean value`,
      );
    }
    out[key] = item;
  }
  return out;
}

function parseRequestParams(
  value: unknown,
  filePath: string,
): AgentFileDefinition['requestParams'] {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "request_params" in ${filePath} must be a mapping of scalar string, number, or boolean values`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new AgentFileParseError(
        `Frontmatter field "request_params.${key}" in ${filePath} must be a scalar string, number, or boolean value`,
      );
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

function aliasTail(alias: string): string {
  return alias.slice(alias.lastIndexOf('/') + 1);
}

function listMatchesAlias(entries: readonly string[], alias: string): boolean {
  const tail = aliasTail(alias);
  return entries.some((entry) => aliasTail(entry) === tail);
}

function warnIncoherentModelConstraints(
  modelAlias: string | undefined,
  allowedModels: readonly string[] | undefined,
  denyModels: readonly string[] | undefined,
  filePath: string,
  warn?: (message: string) => void,
): void {
  if (warn === undefined) return;
  const hasAllowlist = allowedModels !== undefined && allowedModels.length > 0;
  if (modelAlias === undefined) {
    if (hasAllowlist) {
      warn(
        `Frontmatter field "allowed_models" in ${filePath} is set without "model_alias"; a dispatch that does not name a model fails closed instead of falling back to a default`,
      );
    }
    return;
  }
  if (listMatchesAlias(denyModels ?? [], modelAlias)) {
    warn(
      `Frontmatter field "model_alias" in ${filePath} is listed in deny_models; the profile still loads, but binding this alias will fail`,
    );
    return;
  }
  if (hasAllowlist && !listMatchesAlias(allowedModels, modelAlias)) {
    warn(
      `Frontmatter field "model_alias" in ${filePath} is not in allowed_models; the profile still loads, but binding this alias will fail`,
    );
  }
}

function parseBoolean(value: unknown, field: string, filePath: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new AgentFileParseError(
    `Frontmatter field "${field}" in ${filePath} must be a boolean`,
  );
}

function parseDelegationNotice(
  value: unknown,
  filePath: string,
): 'auto' | 'off' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'off') return value;
  throw new AgentFileParseError(
    `Frontmatter field "delegation_notice" in ${filePath} must be "auto" or "off"`,
  );
}

function parseStringList(
  value: unknown,
  field: string,
  filePath: string,
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  if (!Array.isArray(value)) {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a comma-separated string or a list of strings`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AgentFileParseError(
        `Frontmatter field "${field}" in ${filePath} must be a list of non-empty strings`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function requiredNonEmptyString(value: unknown, field: string, filePath: string): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a non-empty string`,
    );
  }
  const parsed = nonEmptyString(value);
  if (parsed === undefined) {
    throw new AgentFileParseError(`Missing required frontmatter field "${field}" in ${filePath}`);
  }
  return parsed;
}

function optionalNonEmptyStringField(
  value: unknown,
  field: string,
  filePath: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentFileParseError(
      `Frontmatter field "${field}" in ${filePath} must be a non-empty string`,
    );
  }
  return value.trim();
}

function deriveNameFromPath(filePath: string): string | undefined {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]*$/, '');
  return name !== '' ? name : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
