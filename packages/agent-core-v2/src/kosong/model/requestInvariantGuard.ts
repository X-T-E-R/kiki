import { Error2 } from '#/_base/errors/errors';
import type { FrozenLLMRequestSnapshot, PreBaselineRequestPatch, RequestInvariantCheckResult, TransportJsonValue } from '#/kosong/contract/extensionHooks';
import type { GenerateOptions } from '#/kosong/contract/provider';
import { REQUEST_IDENTITY_RESERVED_HEADERS } from '#/kosong/requestIdentity/requestIdentityPolicy';
import { REQUEST_IDENTITY_CREDENTIAL_HEADERS } from '#/kosong/requestIdentity/requestIdentityProfile';

type ViolationCode = NonNullable<RequestInvariantCheckResult['violationCode']>;
const PATCH_KEYS = new Set(['extraHeaders', 'sampling', 'serviceTier', 'thinkingEffort', 'maxCompletionTokens', 'extraRequestParams', 'deterministicVendorFields', 'forceFullResponsesInput']);
const HISTORY_KEYS = new Set([
  'messages', 'input', 'contents', 'history', 'system', 'systemPrompt', 'systemInstruction', 'instructions',
  'model', 'protocol', 'providerType', 'provider', 'previous_response_id', 'client_metadata', 'metadata',
  'prompt_cache_key', 'responseFormat', 'response_format', 'httpOptions', 'http_options', 'extraBody', 'extra_body',
  'requestOptions', 'headers', 'baseUrl', 'apiKey', 'abortSignal', 'automaticContinuation', 'continuationToken',
]);
const SIGNATURE_KEYS = new Set(['encrypted', 'redacted', 'encrypted_content', 'signature', 'thoughtSignature', 'thought_signature_b64', 'anthropic_tool_signature', 'extras', 'toolCalls', 'tool_calls']);
const THINKING_KEYS = new Set([
  'thinking', 'reasoning', 'reasoning_effort', 'thinkingConfig', 'thinking_config', 'thinkingBudget', 'thinkingLevel',
  'context_management', 'contextManagement',
]);

function reject(code: ViolationCode, message: string): never {
  throw new Error2(code, message, { details: { retry: false } });
}

function assertField(key: string): void {
  if (key === 'tools' || key === 'functions') reject('TOOL_ORDER_MUTATION_FORBIDDEN', `Request patches cannot replace '${key}'.`);
  if (SIGNATURE_KEYS.has(key)) reject('THINKING_SIGNATURE_MUTATION_FORBIDDEN', `Request patches cannot replace '${key}'.`);
  if (HISTORY_KEYS.has(key) || key.startsWith('x-kiki-') || key === '__proto__' || key === 'constructor' || key === 'prototype') {
    reject('MESSAGE_HISTORY_MUTATION_FORBIDDEN', `Request patches cannot replace '${key}'.`);
  }
}

function copyVendorValue(value: TransportJsonValue, signed = false): TransportJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => copyVendorValue(entry, signed));
  if (typeof value !== 'object' || value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    reject('MESSAGE_HISTORY_MUTATION_FORBIDDEN', 'Vendor patches must contain deterministic JSON values.');
  }
  return Object.fromEntries(Object.keys(value).toSorted().map((key) => {
    assertField(key);
    if (THINKING_KEYS.has(key)) {
      reject(signed ? 'THINKING_DISABLE_WITH_SIGNED_HISTORY' : 'THINKING_SIGNATURE_MUTATION_FORBIDDEN',
        'Use thinkingEffort to change thinking; raw reasoning and thinking fields are provider-owned.');
    }
    return [key, copyVendorValue((value as Record<string, TransportJsonValue>)[key]!, signed)];
  }));
}

export function verifyAndApplyPreBaselinePatch(
  snapshot: FrozenLLMRequestSnapshot,
  options: GenerateOptions,
  patch: PreBaselineRequestPatch | undefined,
): GenerateOptions {
  if (patch === undefined) return options;
  for (const key of Object.keys(patch)) {
    assertField(key);
    if (!PATCH_KEYS.has(key)) reject('MESSAGE_HISTORY_MUTATION_FORBIDDEN', `Unsupported request patch field '${key}'.`);
  }
  for (const key of Object.keys(patch.extraHeaders ?? {})) {
    const name = key.toLowerCase();
    if (REQUEST_IDENTITY_RESERVED_HEADERS.has(name) || REQUEST_IDENTITY_CREDENTIAL_HEADERS.has(name) || name.startsWith('x-kiki-')) {
      reject('RESERVED_HEADER_FORBIDDEN', `Request patch cannot set reserved header '${key}'.`);
    }
  }
  const signed = snapshot.messages.some((message) => message.content.some((part) =>
    part.type === 'think' && ((part.encrypted?.length ?? 0) > 0 || (part.redacted?.length ?? 0) > 0)) ||
    message.toolCalls?.some((call) => typeof call.extras?.['thought_signature_b64'] === 'string' ||
      typeof call.extras?.['anthropic_tool_signature'] === 'string'));
  const vendorFields = { ...patch.extraRequestParams, ...patch.deterministicVendorFields };
  if (signed && (patch.thinkingEffort === 'off' || (patch.thinkingEffort === undefined && options.thinking?.effort === 'off'))) {
    reject('THINKING_DISABLE_WITH_SIGNED_HISTORY', 'Signed thinking history cannot be replayed with thinking disabled.');
  }
  const vendor = copyVendorValue(vendorFields, signed) as Readonly<Record<string, TransportJsonValue>>;
  const thinking = patch.thinkingEffort === undefined ? options.thinking : { ...options.thinking, effort: patch.thinkingEffort };
  return {
    ...options,
    headers: { ...options.headers, ...patch.extraHeaders },
    sampling: { ...options.sampling, ...patch.sampling },
    serviceTier: patch.serviceTier ?? options.serviceTier,
    thinking,
    maxCompletionTokens: patch.maxCompletionTokens === undefined ? options.maxCompletionTokens :
      Math.min(patch.maxCompletionTokens, options.maxCompletionTokens ?? Infinity),
    requestParams: options.requestParams,
    deterministicVendorFields: vendor,
    forceFullResponsesInput: patch.forceFullResponsesInput === true,
    responsesBaselinePolicyKey: JSON.stringify([thinking?.effort ?? null, vendor]),
  };
}
