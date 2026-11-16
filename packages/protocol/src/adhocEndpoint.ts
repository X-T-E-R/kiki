import { z } from 'zod';
import { isDirectConnectionHost } from './rest/connections';

const DEFAULT_PROVIDER_TYPE = 'openai';
const DEFAULT_CAPABILITIES = ['tool_use', 'image_in', 'thinking'] as const;
const DEFAULT_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
const CANONICAL_PROVIDER_TYPES = ['openai', 'openai_responses', 'anthropic', 'google-genai'] as const;
const ENDPOINT_INPUT_KEYS = [
  'provider_type',
  'base_url',
  'model',
  'api_key',
  'api_key_env',
  'capabilities',
  'support_efforts',
  'max_context_size',
  'max_completion_tokens',
  'request_params',
] as const;
const FLAT_ENDPOINT_KEYS = ['base_url', 'provider_type', 'api_key', 'api_key_env'] as const;
const FORBIDDEN_ENDPOINT_KEYS = ['auth', 'credential', 'headers', 'secret_ref'] as const;

const providerAliases: Readonly<Record<string, string>> = {
  'openai-chat': 'openai',
  'openai-legacy': 'openai',
  'openai-responses': 'openai_responses',
};

const envVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const scalarRequestParamSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const requestParamsSchema = z.record(z.string(), scalarRequestParamSchema);
const positiveIntegerSchema = z.number().int().positive().safe();
const canonicalProviderTypeSchema = z.enum(CANONICAL_PROVIDER_TYPES);
const providerTypeInputSchema = z.enum([
  ...CANONICAL_PROVIDER_TYPES,
  'openai-chat',
  'openai-legacy',
  'openai-responses',
]).transform((value) => providerAliases[value] ?? value).pipe(canonicalProviderTypeSchema);
const capabilitySchema = z.enum(['image_in', 'video_in', 'audio_in', 'thinking', 'tool_use']);
const supportEffortSchema = z.enum(DEFAULT_THINKING_EFFORTS);

function canonicalProviderType(value: string): string {
  return providerAliases[value] ?? value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasDefined(record: Record<string, unknown>, key: string): boolean {
  return hasOwn(record, key) && record[key] !== undefined;
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return undefined;
  return octets as [number, number, number, number];
}

function parseIpv6(hostname: string): readonly number[] | undefined {
  const value = hostWithoutBrackets(hostname).toLowerCase();
  if (!value.includes(':') || value.includes('%')) return undefined;
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const parseHalf = (half: string): number[] | undefined => {
    if (half === '') return [];
    const parts = half.split(':');
    const words: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part.includes('.')) {
        if (index !== parts.length - 1) return undefined;
        const ipv4 = parseIpv4(part);
        if (ipv4 === undefined) return undefined;
        words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  if (left === undefined || right === undefined) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  if (left.length + right.length >= 8) return undefined;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}

function isBlockedEndpointHost(hostname: string): boolean {
  const normalized = hostWithoutBrackets(hostname).toLowerCase().replace(/\.$/u, '');
  if (normalized === 'metadata' || normalized === 'metadata.google.internal' || normalized === 'metadata.google.com' || normalized === 'instance-data.ec2.internal') return true;
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined && ipv4[0] === 169 && ipv4[1] === 254) return true;
  const words = parseIpv6(normalized);
  if (words === undefined) return false;
  const first = words[0] ?? 0;
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  if (words[0] === 0xfd00 && words[1] === 0x0ec2 && words.slice(2, 7).every((word) => word === 0) && words[7] === 0x0254) return true;
  if (words.length === 8 && words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const mapped = [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff];
    return mapped[0] === 169 && mapped[1] === 254;
  }
  return false;
}

function isTestHost(hostname: string): boolean {
  const normalized = hostWithoutBrackets(hostname).toLowerCase().replace(/\.$/u, '');
  return normalized.endsWith('.test');
}

function isValidEndpointUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
  if (url.hostname === '' || isBlockedEndpointHost(url.hostname)) return false;
  const host = hostWithoutBrackets(url.hostname).toLowerCase().replace(/\.$/u, '');
  const words = parseIpv6(host);
  const mapped = words?.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
    ? `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}` : undefined;
  return url.protocol === 'https:' || isDirectConnectionHost(host) || host.endsWith('.localhost') || isTestHost(host)
    || (mapped !== undefined && isDirectConnectionHost(mapped));
}

function normalizeEndpointUrl(value: string): string {
  if (!isValidEndpointUrl(value)) throw invalidEndpointError();
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${path}`;
}

function invalidEndpointError(): Error {
  return new Error('Invalid endpoint configuration');
}

const endpointBaseUrlSchema = z.string().trim().min(1).refine(isValidEndpointUrl, { message: 'Invalid endpoint URL' }).transform(normalizeEndpointUrl);
const endpointModelSchema = z.string().trim().min(1);
const endpointCapabilitiesSchema = z.array(capabilitySchema);
const endpointSupportEffortsSchema = z.array(supportEffortSchema);
const endpointInputObjectSchema = z.strictObject({
  provider_type: providerTypeInputSchema.optional(),
  base_url: endpointBaseUrlSchema.optional(),
  model: endpointModelSchema.optional(),
  api_key: z.string().refine((value) => value.trim().length > 0, 'API key must not be empty').optional(),
  api_key_env: z.string().regex(envVariablePattern).optional(),
  capabilities: endpointCapabilitiesSchema.optional(),
  support_efforts: endpointSupportEffortsSchema.optional(),
  max_context_size: positiveIntegerSchema.optional(),
  max_completion_tokens: positiveIntegerSchema.optional(),
  request_params: requestParamsSchema.optional(),
});

export const adhocEndpointInputSchema = endpointInputObjectSchema.partial().superRefine((value, context) => {
  if (value.api_key !== undefined && value.api_key_env !== undefined) context.addIssue({ code: 'custom', message: 'Endpoint authentication must use one credential source' });
});
export type AdhocEndpointInput = z.infer<typeof adhocEndpointInputSchema>;

function parseEndpointInput(value: unknown): AdhocEndpointInput {
  const parsed = adhocEndpointInputSchema.safeParse(value);
  if (!parsed.success) throw invalidEndpointError();
  return parsed.data;
}

export function normalizeEndpointLayer(record: Record<string, unknown>): AdhocEndpointInput | undefined {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) throw invalidEndpointError();
  const hasStructuredEndpoint = hasDefined(record, 'endpoint');
  const hasFlatEndpointField = ENDPOINT_INPUT_KEYS.some((key) => hasDefined(record, key) && key !== 'capabilities' && key !== 'support_efforts' && key !== 'max_context_size' && key !== 'max_completion_tokens' && key !== 'request_params');
  if (hasStructuredEndpoint) {
    if (hasFlatEndpointField) throw invalidEndpointError();
    if (FORBIDDEN_ENDPOINT_KEYS.some((key) => hasDefined(record, key))) throw invalidEndpointError();
    const endpoint = record['endpoint'];
    if (typeof endpoint !== 'object' || endpoint === null || Array.isArray(endpoint)) throw invalidEndpointError();
    const parsed = parseEndpointInput(endpoint);
    return Object.keys(parsed).length === 0 ? undefined : { ...parsed };
  }
  const hasNonModelEndpointField = FLAT_ENDPOINT_KEYS.some((key) => hasDefined(record, key));
  if (!hasNonModelEndpointField) return undefined;
  if (FORBIDDEN_ENDPOINT_KEYS.some((key) => hasDefined(record, key))) throw invalidEndpointError();
  const candidate: Record<string, unknown> = {};
  for (const key of ENDPOINT_INPUT_KEYS) {
    if (hasDefined(record, key)) candidate[key] = record[key];
  }
  return { ...parseEndpointInput(candidate) };
}

function normalizedProviderForIdentity(value: string | undefined): string {
  return canonicalProviderType(value ?? DEFAULT_PROVIDER_TYPE);
}

function normalizedUrlForIdentity(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeEndpointUrl(value);
}

function endpointIdentityChanged(base: AdhocEndpointInput | undefined, merged: AdhocEndpointInput): boolean {
  return normalizedProviderForIdentity(base?.provider_type) !== normalizedProviderForIdentity(merged.provider_type) ||
    normalizedUrlForIdentity(base?.base_url) !== normalizedUrlForIdentity(merged.base_url);
}

export function mergeEndpointInputs(base: AdhocEndpointInput | undefined, override: AdhocEndpointInput | undefined): AdhocEndpointInput | undefined {
  if (base === undefined && override === undefined) return undefined;
  const baseValue = base === undefined ? undefined : parseEndpointInput(base);
  const overrideValue = override === undefined ? undefined : parseEndpointInput(override);
  const merged: Record<string, unknown> = { ...baseValue, ...overrideValue };
  if (baseValue?.request_params !== undefined || overrideValue?.request_params !== undefined) merged['request_params'] = { ...baseValue?.request_params, ...overrideValue?.request_params };
  const changed = endpointIdentityChanged(baseValue, merged as AdhocEndpointInput);
  if (overrideValue?.api_key !== undefined) {
    merged['api_key'] = overrideValue.api_key;
    delete merged['api_key_env'];
  } else if (overrideValue?.api_key_env !== undefined) {
    merged['api_key_env'] = overrideValue.api_key_env;
    delete merged['api_key'];
  } else if (changed) {
    delete merged['api_key'];
    delete merged['api_key_env'];
  }
  return { ...parseEndpointInput(merged) };
}

const boundCredentialSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('env'), env: z.string().regex(envVariablePattern) }),
  z.strictObject({ kind: z.literal('ephemeral'), secretRef: z.string().trim().min(1) }),
]);
const boundEndpointBaseSchema = z.strictObject({
  provider_type: canonicalProviderTypeSchema.default(DEFAULT_PROVIDER_TYPE),
  base_url: endpointBaseUrlSchema,
  model: endpointModelSchema,
  capabilities: endpointCapabilitiesSchema.default([...DEFAULT_CAPABILITIES]),
  support_efforts: endpointSupportEffortsSchema.optional(),
  max_context_size: positiveIntegerSchema.default(131_072),
  max_completion_tokens: positiveIntegerSchema.optional(),
  request_params: requestParamsSchema.optional(),
  credential: boundCredentialSchema,
});

export const adhocEndpointModelSchema = boundEndpointBaseSchema.omit({ credential: true }).transform((value) => {
  if (value.support_efforts !== undefined || !value.capabilities.includes('thinking')) return value;
  return { ...value, support_efforts: [...DEFAULT_THINKING_EFFORTS] };
});

export const boundEndpointSchema = boundEndpointBaseSchema.transform((value) => {
  if (value.support_efforts !== undefined || !value.capabilities.includes('thinking')) return value;
  return { ...value, support_efforts: [...DEFAULT_THINKING_EFFORTS] };
});
export type BoundEndpoint = z.infer<typeof boundEndpointSchema>;

export function adhocEndpointModelId(endpoint: Pick<BoundEndpoint, 'provider_type' | 'base_url' | 'model'>): string {
  if (typeof endpoint.provider_type !== 'string' || typeof endpoint.base_url !== 'string' || typeof endpoint.model !== 'string') throw invalidEndpointError();
  const provider = canonicalProviderType(endpoint.provider_type.trim());
  const model = endpoint.model.trim();
  if (provider === '' || model === '' || !canonicalProviderTypeSchema.safeParse(provider).success) throw invalidEndpointError();
  return `adhoc:${provider}@${normalizeEndpointUrl(endpoint.base_url)}#${model}`;
}
