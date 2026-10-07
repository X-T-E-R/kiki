/**
 * Connection presets and protocol vocabulary for the provider UI. Presets are
 * a vendor-neutral starting point for an API-key connection: each fills a
 * protocol, a base URL and a default context size, and nothing else — the
 * user still owns the key and models, and may rename the suggested id. Account sign-in (OAuth) methods are
 * listed by the server (`listOAuthMethods`), not here.
 */

import { providerIdSchema } from '@kiki/protocol';
import type { ValidationIssue } from '@kiki/session-core/i18n';
import { DEFAULT_MODEL_CAPABILITIES, DEFAULT_MODEL_SUPPORT_EFFORTS, validateProviderDraft, type ProviderDraft } from '@kiki/session-core/settings';

export type ProviderWireType = ProviderDraft['type'];

export type ProviderPresetGroup = 'vendor' | 'gateway' | 'local';

export interface ProviderPreset {
  /** Stable id; also the suggested provider id. */
  readonly id: string;
  /** Brand label — stays English in both locales. */
  readonly label: string;
  readonly type: ProviderWireType;
  readonly baseUrl: string;
  readonly defaultContextSize: number;
  readonly group: ProviderPresetGroup;
  /** A local server usually needs no key. */
  readonly keyOptional?: boolean;
}

/** Alphabetical inside each group, so no vendor reads as the default. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultContextSize: 200_000, group: 'vendor' },
  { id: 'deepseek', label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', defaultContextSize: 128_000, group: 'vendor' },
  { id: 'gemini', label: 'Google Gemini', type: 'google-genai', baseUrl: 'https://generativelanguage.googleapis.com', defaultContextSize: 1_000_000, group: 'vendor' },
  { id: 'mistral', label: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', defaultContextSize: 128_000, group: 'vendor' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', type: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', defaultContextSize: 131_072, group: 'vendor' },
  { id: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', defaultContextSize: 128_000, group: 'vendor' },
  { id: 'qwen', label: 'Qwen (DashScope)', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultContextSize: 131_072, group: 'vendor' },
  { id: 'xai', label: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', defaultContextSize: 131_072, group: 'vendor' },
  { id: 'zhipu', label: 'Zhipu GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultContextSize: 128_000, group: 'vendor' },
  { id: 'openrouter', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultContextSize: 128_000, group: 'gateway' },
  { id: 'siliconflow', label: 'SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', defaultContextSize: 128_000, group: 'gateway' },
  { id: 'lmstudio', label: 'LM Studio', type: 'openai', baseUrl: 'http://localhost:1234/v1', defaultContextSize: 32_768, group: 'local', keyOptional: true },
  { id: 'ollama', label: 'Ollama', type: 'openai', baseUrl: 'http://localhost:11434/v1', defaultContextSize: 32_768, group: 'local', keyOptional: true },
];

export const PROVIDER_PRESET_GROUPS: readonly ProviderPresetGroup[] = ['vendor', 'gateway', 'local'];

/** Wire protocols in the order the protocol picker lists them. */
export const PROTOCOL_ORDER: readonly ProviderWireType[] = [
  'openai',
  'openai_responses',
  'anthropic',
  'google-genai',
  'vertexai',
  'kimi',
];

/** New connections choose the five public protocols; existing Kimi adapters remain editable. */
export const API_PROTOCOLS: readonly ProviderWireType[] = PROTOCOL_ORDER.filter((type) => type !== 'kimi');

/** Short human protocol names — technical terms, identical in both locales. */
export const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI Chat Completions',
  openai_responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  'google-genai': 'Google Gemini',
  vertexai: 'Vertex AI',
  kimi: 'OpenAI-compatible · Moonshot',
};

export function protocolLabel(type: string): string {
  return PROTOCOL_LABELS[type] ?? type;
}

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function defaultContextFor(type: ProviderWireType, presetId?: string): number {
  if (presetId !== undefined) {
    const preset = presetById(presetId);
    if (preset !== undefined) return preset.defaultContextSize;
  }
  return type === 'anthropic' ? 200_000 : type === 'kimi' ? 131_072 : 128_000;
}

/** Best-effort vendor label for a configured connection, from its base URL host. */
export function vendorLabelFor(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  const match = PROVIDER_PRESETS.find((preset) => {
    try {
      return new URL(preset.baseUrl).host === host;
    } catch {
      return false;
    }
  });
  return match?.label;
}

/**
 * How a configured connection reaches its models, as the list groups them:
 * an account sign-in (OAuth-managed), a server on this machine, or a hosted
 * API reached with a key. There is deliberately no per-vendor kind.
 */
export type ConnectionKind = 'account' | 'local' | 'api';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl === '') return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.local') || /^192\.168\.|^10\./.test(host);
  } catch {
    return false;
  }
}

export function connectionKind(
  provider: { readonly id: string; readonly base_url?: string },
  accountProviders: ReadonlySet<string>,
): ConnectionKind {
  if (accountProviders.has(provider.id)) return 'account';
  return isLocalBaseUrl(provider.base_url) ? 'local' : 'api';
}

/** `api.deepseek.com` / `localhost:11434` — the address a person recognizes. */
export function hostLabel(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined || baseUrl === '') return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** One blank model row sized for the protocol or preset. */
export function blankModelRow(contextSize: number): ProviderDraft['models'][number] {
  return {
    id: '',
    remoteId: '',
    maxContextSize: contextSize,
    displayName: '',
    capabilities: [...DEFAULT_MODEL_CAPABILITIES],
    supportEfforts: [...DEFAULT_MODEL_SUPPORT_EFFORTS],
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
  };
}

/** Host labels that name a role, not a vendor (`api.deepseek.com` → `deepseek`). */
const GENERIC_HOST_LABELS = new Set(['api', 'www', 'open', 'openapi', 'gateway', 'llm', 'inference', 'models', 'chat']);
/** Second-level labels of compound public suffixes (`example.com.cn`). */
const COMPOUND_SUFFIX_LABELS = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'ac']);

/**
 * A suggested connection id derived from a base URL: a known preset's id when
 * the host matches one, otherwise the most vendor-like host label, shaped to
 * the create-time id rule (letters/digits first, then `-`/`_`). Returns ''
 * when the URL has no usable host, so callers can leave the field empty.
 */
export function providerIdFromBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (host === '') return '';
  // host includes the port, so two local servers on one machine stay apart.
  const preset = PROVIDER_PRESETS.find((candidate) => {
    try {
      return new URL(candidate.baseUrl).host === url.host;
    } catch {
      return false;
    }
  });
  if (preset !== undefined) return preset.id;
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[')) return 'local';
  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && COMPOUND_SUFFIX_LABELS.has(labels[labels.length - 1]!)) labels.pop();
  const label = labels.find((candidate) => !GENERIC_HOST_LABELS.has(candidate)) ?? labels[labels.length - 1] ?? '';
  return label.replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '');
}

/**
 * Apply a base URL edit to a new-connection draft. The id follows the URL
 * while it is empty or still holds the id the previous URL suggested; once
 * the user types their own id it is left alone.
 */
export function withBaseUrl(draft: ProviderDraft, baseUrl: string): ProviderDraft {
  const follows = draft.id === '' || draft.id === providerIdFromBaseUrl(draft.baseUrl);
  return { ...draft, baseUrl, id: follows ? providerIdFromBaseUrl(baseUrl) : draft.id };
}

/** Which new-connection field a validation issue belongs to. */
export type ConnectionField = 'id' | 'baseUrl';

/**
 * Whether a new connection on this protocol needs an explicit address. The
 * Google adapters fall back to Google's own endpoint; every other protocol is
 * a shape many services speak, so without a URL there is nothing to call.
 */
export function baseUrlRequired(type: ProviderWireType): boolean {
  return type !== 'google-genai' && type !== 'vertexai';
}

export interface ConnectionFieldIssue {
  readonly field: ConnectionField;
  readonly issue: ValidationIssue;
}

/**
 * The field-level checks for a new API-key connection, in the order a person
 * fixes them: the base URL first (a valid one also fills the id), then the id.
 * Everything else (models, context size) stays with `validateNewProviderDraft`.
 */
export function connectionFieldIssue(
  draft: ProviderDraft,
  options: { readonly requireBaseUrl?: boolean } = {},
): ConnectionFieldIssue | null {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl === '' && options.requireBaseUrl === true) {
    return { field: 'baseUrl', issue: { key: 'val.baseUrlRequired' } };
  }
  if (baseUrl !== '') {
    const urlIssue = validateProviderDraft({ ...draft, models: [], defaultModel: '' });
    if (urlIssue !== null && urlIssue.key.startsWith('val.baseUrl')) return { field: 'baseUrl', issue: urlIssue };
  }
  if (draft.id.trim() === '') return { field: 'id', issue: { key: 'val.providerIdEmpty' } };
  if (!providerIdSchema.safeParse(draft.id).success) return { field: 'id', issue: { key: 'val.providerId' } };
  return null;
}

/** A fresh API-key draft for a preset or an explicitly selected wire protocol. */
export function draftForPreset(preset: ProviderPreset | null, protocol: ProviderWireType = 'openai'): ProviderDraft {
  const type = preset?.type ?? protocol;
  return {
    id: preset?.id ?? '',
    type,
    baseUrl: preset?.baseUrl ?? '',
    defaultModel: '',
    apiKey: '',
    clearApiKey: false,
    requestIdentityChoice: 'inherit',
    requestIdentityOverridesJson: '',
    imageAcceptedTypes: null,
    imageConvertUnsupported: null,
    models: [blankModelRow(defaultContextFor(type, preset?.id))],
  };
}
