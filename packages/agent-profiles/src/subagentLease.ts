import type {
  AgentModelProfile,
  AgentModelProfilePromptMode,
  AgentSubagentPolicy,
  RequestParams,
  ServiceTier,
  SubagentDeclaration,
} from './agentProfile';

export class SubagentLeaseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentLeaseParseError';
  }
}

export type SubagentLeasePromptMode = AgentModelProfilePromptMode;

interface SubagentLeaseOverlay {
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: string;
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly tools?: readonly string[] | null;
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[] | null;
  readonly promptMode?: SubagentLeasePromptMode;
  readonly prompt?: string;
  readonly delegationNotice?: 'auto' | 'off';
  readonly serviceTier?: ServiceTier | null;
  readonly requestParams?: RequestParams | null;
  readonly modelProfiles?: readonly AgentModelProfile[];
}

export interface NamedSubagentLease extends SubagentLeaseOverlay {
  readonly source?: never;
}

export interface SourceSubagentLease extends SubagentLeaseOverlay {
  readonly source: string;
}

export type SubagentLease = NamedSubagentLease | SourceSubagentLease;

export function isSourceSubagentLease(lease: SubagentLease): lease is SourceSubagentLease {
  return lease.source !== undefined;
}

export interface SpawnConstraints {
  readonly allowedModels?: readonly string[];
  readonly denyModels?: readonly string[];
  readonly allowedEfforts?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

export interface ParsedSubagentField {
  readonly declaration?: SubagentDeclaration;
  readonly subagents?: readonly string[];
  readonly subagentLeases?: Readonly<Record<string, SubagentLease>>;
}

const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LEASE_KEYS = new Set([
  'name',
  'source',
  'description',
  'whenToUse',
  'model_preference',
  'model_alias',
  'thinking_effort',
  'allowed_models',
  'deny_models',
  'allowed_efforts',
  'tools',
  'disallowedTools',
  'subagents',
  'prompt',
  'prompt_mode',
  'delegation_notice',
  'service_tier',
  'request_params',
  'model_profiles',
]);

const FORBIDDEN_LEASE_KEYS = new Set(['main', 'override', 'id', 'profile', 'spawn_constraints']);

const SPAWN_CONSTRAINT_KEYS = new Set([
  'allowed_models',
  'deny_models',
  'allowed_efforts',
  'disallowed_tools',
]);

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

export function parseSubagentList(
  value: unknown,
  filePath: string,
  policy?: AgentSubagentPolicy,
): ParsedSubagentField {
  if (value === undefined) {
    return policy === undefined ? {} : { declaration: { kind: 'inherit' } };
  }
  if (value === null) {
    if (policy === undefined) return {};
    throw new SubagentLeaseParseError(
      `Frontmatter field "subagents" in ${filePath} cannot be null when subagent_policy is set; omit it to inherit, use [] for none, or ["*"] for all`,
    );
  }
  if (typeof value === 'string') {
    const names = splitCommaList(value);
    if (names === undefined) {
      if (policy === undefined) return {};
      throw new SubagentLeaseParseError(
        `Frontmatter field "subagents" in ${filePath} cannot be empty when subagent_policy is set; omit it to inherit, use [] for none, or ["*"] for all`,
      );
    }
    return parsedSubagentNames(names, undefined, filePath, policy);
  }
  if (!Array.isArray(value)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "subagents" in ${filePath} must be a comma-separated string or a list of names or mappings`,
    );
  }
  const names: string[] = [];
  const leases: Record<string, SubagentLease> = {};
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name === '') {
        throw new SubagentLeaseParseError(
          `Frontmatter field "subagents[${index}]" in ${filePath} must be a non-empty string or a mapping`,
        );
      }
      recordName(name, seen, filePath, index);
      names.push(name);
      continue;
    }
    if (!isRecord(item)) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "subagents[${index}]" in ${filePath} must be a non-empty string or a mapping`,
      );
    }
    const lease = parseLeaseMapping(item, filePath, index, policy !== undefined);
    recordName(lease.name, seen, filePath, index);
    names.push(lease.name);
    Object.defineProperty(leases, lease.name, {
      value: lease,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return parsedSubagentNames(names, leases, filePath, policy);
}

function parsedSubagentNames(
  names: readonly string[],
  leases: Readonly<Record<string, SubagentLease>> | undefined,
  filePath: string,
  policy: AgentSubagentPolicy | undefined,
): ParsedSubagentField {
  const hasWildcard = names.includes('*');
  if (policy !== undefined && hasWildcard && names.length !== 1) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "subagents" in ${filePath} cannot mix "*" with named recommendations when subagent_policy is set`,
    );
  }
  const declaration: SubagentDeclaration | undefined = policy === undefined
    ? undefined
    : hasWildcard
      ? { kind: 'all' }
      : { kind: 'set', names };
  return {
    ...(declaration === undefined ? {} : { declaration }),
    subagents: normalizeAllowlist(names),
    ...(leases === undefined || Object.keys(leases).length === 0 ? {} : { subagentLeases: leases }),
  };
}

export function parseSpawnConstraints(
  value: unknown,
  filePath: string,
): SpawnConstraints | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "spawn_constraints" in ${filePath} must be a mapping`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!SPAWN_CONSTRAINT_KEYS.has(key)) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "spawn_constraints" in ${filePath} contains unknown key "${key}"`,
      );
    }
  }
  const allowedModels = normalizeModelAllowlist(
    parseStringList(value['allowed_models'], 'spawn_constraints.allowed_models', filePath),
  );
  const denyModels = openIfEmpty(
    parseStringList(value['deny_models'], 'spawn_constraints.deny_models', filePath),
  );
  const allowedEfforts = openIfEmpty(
    parseStringList(value['allowed_efforts'], 'spawn_constraints.allowed_efforts', filePath),
  );
  const disallowedTools = openIfEmpty(
    parseStringList(value['disallowed_tools'], 'spawn_constraints.disallowed_tools', filePath),
  );
  if (
    allowedModels === undefined &&
    denyModels === undefined &&
    allowedEfforts === undefined &&
    disallowedTools === undefined
  ) {
    return undefined;
  }
  return {
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(denyModels === undefined ? {} : { denyModels }),
    ...(allowedEfforts === undefined ? {} : { allowedEfforts }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
  };
}

function parseLeaseMapping(
  item: Record<string, unknown>,
  filePath: string,
  index: number,
  strictSyntax: boolean,
): SubagentLease {
  for (const key of Object.keys(item)) {
    if (FORBIDDEN_LEASE_KEYS.has(key)) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "subagents[${index}].${key}" in ${filePath} cannot be overlaid on a subagent lease`,
      );
    }
    if (!LEASE_KEYS.has(key)) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "subagents[${index}]" in ${filePath} contains unknown key "${key}"`,
      );
    }
  }
  const prefix = `subagents[${index}]`;
  const name = requiredString(item['name'], `${prefix}.name`, filePath);
  if (name.includes('.')) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${prefix}.name" in ${filePath} must be a kebab-case profile name, not a route id; use route on the Agent tool`,
    );
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${prefix}.name" in ${filePath} must be kebab-case`,
    );
  }
  const source = parseSourcePath(item['source'], `${prefix}.source`, filePath);
  rejectModelPreference(item['model_preference'], `${prefix}.model_preference`, filePath);
  const modelAlias = optionalString(item['model_alias'], `${prefix}.model_alias`, filePath);
  const promptMode = parsePromptMode(item['prompt_mode'], `${prefix}.prompt_mode`, filePath);
  const prompt = optionalString(item['prompt'], `${prefix}.prompt`, filePath);
  if (promptMode !== undefined && prompt === undefined) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${prefix}.prompt" in ${filePath} is required when prompt_mode is set`,
    );
  }
  if (prompt !== undefined && promptMode === undefined) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${prefix}.prompt_mode" in ${filePath} is required when prompt is set`,
    );
  }
  if (promptMode !== undefined && prompt !== undefined) {
    validateLeasePrompt(promptMode, prompt, prefix, filePath);
  }
  const description = optionalString(item['description'], `${prefix}.description`, filePath);
  const whenToUse = optionalString(item['whenToUse'], `${prefix}.whenToUse`, filePath);
  const thinkingEffort = optionalString(
    item['thinking_effort'],
    `${prefix}.thinking_effort`,
    filePath,
  );
  const allowedModels = normalizeModelAllowlist(
    parseStringList(item['allowed_models'], `${prefix}.allowed_models`, filePath),
  );
  const denyModels = openIfEmpty(
    parseStringList(item['deny_models'], `${prefix}.deny_models`, filePath),
  );
  const allowedEfforts = openIfEmpty(
    parseStringList(item['allowed_efforts'], `${prefix}.allowed_efforts`, filePath),
  );
  const rawSubagentValue = item['subagents'];
  const rawSubagents = parseStringList(rawSubagentValue, `${prefix}.subagents`, filePath);
  if (strictSyntax && Object.hasOwn(item, 'subagents')) {
    if (rawSubagentValue === null || rawSubagents === undefined) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${prefix}.subagents" in ${filePath} cannot be null or empty when subagent_policy is set`,
      );
    }
    if (rawSubagents.includes('*') && rawSubagents.length !== 1) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${prefix}.subagents" in ${filePath} cannot mix "*" with named entries when subagent_policy is set`,
      );
    }
  }
  const subagents =
    rawSubagents === undefined ? undefined : rawSubagents.includes('*') ? null : rawSubagents;
  return {
    name,
    ...(source === undefined ? {} : { source }),
    ...(description === undefined ? {} : { description }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
    ...(modelAlias === undefined ? {} : { modelAlias }),
    ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
    ...(allowedModels === undefined ? {} : { allowedModels }),
    ...(denyModels === undefined ? {} : { denyModels }),
    ...(allowedEfforts === undefined ? {} : { allowedEfforts }),
    ...(normalizeTools(parseStringList(item['tools'], `${prefix}.tools`, filePath)) === undefined
      ? {}
      : { tools: normalizeTools(parseStringList(item['tools'], `${prefix}.tools`, filePath)) }),
    ...(parseStringList(item['disallowedTools'], `${prefix}.disallowedTools`, filePath) === undefined
      ? {}
      : { disallowedTools: parseStringList(item['disallowedTools'], `${prefix}.disallowedTools`, filePath) }),
    ...(subagents === undefined ? {} : { subagents }),
    ...(promptMode === undefined ? {} : { promptMode, prompt }),
    ...(parseDelegationNotice(item['delegation_notice'], `${prefix}.delegation_notice`, filePath) === undefined
      ? {}
      : {
          delegationNotice: parseDelegationNotice(
            item['delegation_notice'],
            `${prefix}.delegation_notice`,
            filePath,
          ),
        }),
    ...(parseServiceTier(item['service_tier'], `${prefix}.service_tier`, filePath) === undefined
      ? {}
      : { serviceTier: parseServiceTier(item['service_tier'], `${prefix}.service_tier`, filePath) }),
    ...(parseRequestParams(item['request_params'], `${prefix}.request_params`, filePath) === undefined
      ? {}
      : { requestParams: parseRequestParams(item['request_params'], `${prefix}.request_params`, filePath) }),
    ...(parseModelProfiles(item['model_profiles'], `${prefix}.model_profiles`, filePath) === undefined
      ? {}
      : { modelProfiles: parseModelProfiles(item['model_profiles'], `${prefix}.model_profiles`, filePath) }),
  };
}

function recordName(name: string, seen: Set<string>, filePath: string, index: number): void {
  if (seen.has(name)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "subagents" in ${filePath} lists "${name}" more than once`,
    );
  }
  seen.add(name);
  void index;
}

function normalizeAllowlist(names: readonly string[]): readonly string[] | undefined {
  if (names.includes('*')) return undefined;
  return names;
}

export function normalizeModelAllowlist(list: readonly string[] | undefined): readonly string[] | undefined {
  return list?.includes('*') ? undefined : list;
}

export function openIfEmpty(list: readonly string[] | undefined): readonly string[] | undefined {
  if (list === undefined || list.length === 0) return undefined;
  return list;
}

function normalizeTools(names: readonly string[] | undefined): readonly string[] | null | undefined {
  if (names === undefined) return undefined;
  if (names.length === 1 && names[0] === '*') return null;
  return names;
}

function parsePromptMode(
  value: unknown,
  field: string,
  filePath: string,
): SubagentLeasePromptMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'replace') {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${field}" in ${filePath} cannot be "replace"; use prepend, append, or wrap`,
    );
  }
  if (value === 'prepend' || value === 'append' || value === 'wrap') return value;
  throw new SubagentLeaseParseError(
    `Frontmatter field "${field}" in ${filePath} must be "prepend", "append", or "wrap"`,
  );
}

function validateLeasePrompt(
  mode: SubagentLeasePromptMode,
  prompt: string,
  prefix: string,
  filePath: string,
): void {
  const count =
    prompt.split('${base_prompt}').length - 1 + (prompt.split('${parent_prompt}').length - 1);
  if (mode === 'wrap') {
    if (count !== 1) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${prefix}.prompt" in ${filePath} with prompt_mode "wrap" requires \${parent_prompt} (or \${base_prompt}) exactly once`,
      );
    }
    return;
  }
  if (count !== 0) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${prefix}.prompt" in ${filePath} with prompt_mode "${mode}" does not allow \${parent_prompt} or \${base_prompt}`,
    );
  }
}

function parseModelProfiles(
  value: unknown,
  field: string,
  filePath: string,
): readonly AgentModelProfile[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new SubagentLeaseParseError(`Frontmatter field "${field}" in ${filePath} must be a list of mappings`);
  }
  const out: AgentModelProfile[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${field}[${index}]" in ${filePath} must be a mapping`,
      );
    }
    for (const key of Object.keys(item)) {
      if (!MODEL_PROFILE_ENTRY_KEYS.has(key)) {
        throw new SubagentLeaseParseError(
          `Frontmatter field "${field}[${index}]" in ${filePath} contains unknown key "${key}"`,
        );
      }
    }
    const prefix = `${field}[${index}]`;
    const alias = requiredString(item['alias'], `${prefix}.alias`, filePath);
    const when = optionalString(item['when'], `${prefix}.when`, filePath);
    const thinkingEffort = optionalString(item['thinking_effort'], `${prefix}.thinking_effort`, filePath);
    const promptMode = parsePromptMode(item['prompt_mode'], `${prefix}.prompt_mode`, filePath);
    const prompt = optionalString(item['prompt'], `${prefix}.prompt`, filePath);
    if (promptMode !== undefined && prompt === undefined) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${prefix}.prompt" in ${filePath} is required when prompt_mode is set`,
      );
    }
    if (prompt !== undefined && promptMode === undefined) {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${prefix}.prompt_mode" in ${filePath} is required when prompt is set`,
      );
    }
    if (promptMode !== undefined && prompt !== undefined) {
      validateLeasePrompt(promptMode, prompt, prefix, filePath);
    }
    const allowedEfforts = openIfEmpty(
      parseStringList(item['allowed_efforts'], `${prefix}.allowed_efforts`, filePath),
    );
    out.push({
      alias,
      when,
      thinkingEffort,
      promptMode,
      prompt,
      allowedEfforts,
      serviceTier: parseServiceTier(item['service_tier'], `${prefix}.service_tier`, filePath) ?? undefined,
      requestParams: parseRequestParams(item['request_params'], `${prefix}.request_params`, filePath) ?? undefined,
      contextBudget: parseTokenBudget(item['context_budget'], `${prefix}.context_budget`, filePath),
      maxCompletionTokens: parseTokenBudget(item['max_completion_tokens'], `${prefix}.max_completion_tokens`, filePath),
    });
  }
  return out;
}

function parseTokenBudget(value: unknown, field: string, filePath: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new SubagentLeaseParseError(`Frontmatter field "${field}" in ${filePath} must be a positive integer token budget`);
}

function rejectModelPreference(value: unknown, field: string, filePath: string): void {
  if (value === undefined || value === null) return;
  throw new SubagentLeaseParseError(
    `Frontmatter field "${field}" in ${filePath} has been removed. Use "model_alias: inherit" to explicitly follow the caller, or set "model_alias" to an exact [models] alias.`,
  );
}

function parseDelegationNotice(
  value: unknown,
  field: string,
  filePath: string,
): 'auto' | 'off' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'off') return value;
  throw new SubagentLeaseParseError(`Frontmatter field "${field}" in ${filePath} must be "auto" or "off"`);
}

function parseServiceTier(
  value: unknown,
  field: string,
  filePath: string,
): ServiceTier | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === 'auto' || value === 'default' || value === 'flex' || value === 'priority') return value;
  throw new SubagentLeaseParseError(
    `Frontmatter field "${field}" in ${filePath} must be "auto", "default", "flex", "priority", or null`,
  );
}

function parseRequestParams(
  value: unknown,
  field: string,
  filePath: string,
): RequestParams | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${field}" in ${filePath} must be a mapping of scalar string, number, or boolean values, or null`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${field}.${key}" in ${filePath} must be a scalar string, number, or boolean value`,
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

function parseStringList(value: unknown, field: string, filePath: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return splitCommaList(value);
  if (!Array.isArray(value)) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${field}" in ${filePath} must be a comma-separated string or a list of strings`,
    );
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new SubagentLeaseParseError(
        `Frontmatter field "${field}" in ${filePath} must be a list of non-empty strings`,
      );
    }
    out.push(item.trim());
  }
  return out;
}

function splitCommaList(value: string): readonly string[] | undefined {
  const names = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return names.length === 0 ? undefined : names;
}

function parseSourcePath(value: unknown, field: string, filePath: string): string | undefined {
  const source = optionalString(value, field, filePath);
  if (source === undefined) return undefined;
  if (
    source.startsWith('~') ||
    source.startsWith('/') ||
    source.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/u.test(source) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(source) ||
    /\$(?:\{|[a-zA-Z_])|%[^%]+%/u.test(source)
  ) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${field}" in ${filePath} must be a relative .md path without home, URI, or environment-variable expansion`,
    );
  }
  if (!source.toLowerCase().endsWith('.md')) {
    throw new SubagentLeaseParseError(
      `Frontmatter field "${field}" in ${filePath} must be a relative .md path`,
    );
  }
  return source.replaceAll('\\', '/');
}

function requiredString(value: unknown, field: string, filePath: string): string {
  const parsed = optionalString(value, field, filePath);
  if (parsed === undefined) {
    throw new SubagentLeaseParseError(`Missing required frontmatter field "${field}" in ${filePath}`);
  }
  return parsed;
}

function optionalString(value: unknown, field: string, filePath: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SubagentLeaseParseError(`Frontmatter field "${field}" in ${filePath} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
