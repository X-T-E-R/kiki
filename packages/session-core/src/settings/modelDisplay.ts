import { resolveCatalogModel } from './agentSettings';

export interface CatalogModelLike {
  readonly id: string;
  readonly remote_id: string;
  readonly provider_id: string;
  readonly display_name?: string;
  readonly provider_display_name?: string;
}

export interface ModelDisplayResult {
  readonly label: string;
  readonly known: boolean;
  readonly rawId?: string;
  readonly providerLabel?: string;
  readonly ambiguous?: boolean;
}

const KNOWN_PUBLIC_ALIASES: Readonly<Record<string, string>> = {
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 mini',
  'gpt-4o': 'GPT-4o',
  'gpt-4.1': 'GPT-4.1',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
};

const catalogCache = new WeakMap<readonly CatalogModelLike[], Map<string, ModelDisplayResult>>();

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function humanProviderLabel(item: CatalogModelLike): string | undefined {
  const explicit = nonBlank(item.provider_display_name);
  if (explicit !== undefined) return explicit;
  const provider = nonBlank(item.provider_id);
  if (provider === undefined) return undefined;
  const stripped = provider.replace(/^managed:/, '');
  if (stripped === '' || stripped.includes('/')) return undefined;
  return stripped;
}

function findUnambiguousCatalogMatch(
  items: readonly CatalogModelLike[],
  rawId: string,
): { readonly match?: CatalogModelLike; readonly ambiguous: boolean } {
  const exact = items.find((item) => item.id === rawId);
  if (exact !== undefined) return { match: exact, ambiguous: false };
  if (!rawId.includes('/')) {
    const suffixMatches = items.filter((item) => item.id.endsWith(`/${rawId}`));
    if (suffixMatches.length === 1) return { match: suffixMatches[0], ambiguous: false };
    if (suffixMatches.length > 1) return { match: undefined, ambiguous: true };
    const remoteMatches = items.filter((item) => item.remote_id === rawId);
    if (remoteMatches.length === 1) return { match: remoteMatches[0], ambiguous: false };
    if (remoteMatches.length > 1) return { match: undefined, ambiguous: true };
    return { match: undefined, ambiguous: false };
  }
  const resolved = resolveCatalogModel(items, rawId);
  if (resolved !== undefined) return { match: resolved, ambiguous: false };
  return { match: undefined, ambiguous: false };
}

export function resolveModelDisplay(
  rawId: string | undefined,
  options: {
    readonly catalog?: readonly CatalogModelLike[];
    readonly unknownLabel: string;
    readonly scope?: string;
    readonly externalExecutor?: boolean;
  },
): ModelDisplayResult {
  const trimmed = nonBlank(rawId);
  if (trimmed === undefined) {
    return { label: options.unknownLabel, known: false };
  }

  if (options.externalExecutor === true) {
    const publicAlias = !trimmed.includes('/') ? KNOWN_PUBLIC_ALIASES[trimmed] : undefined;
    if (publicAlias !== undefined) {
      return { label: publicAlias, known: true, rawId: trimmed };
    }
    return { label: options.unknownLabel, known: false, rawId: trimmed };
  }

  const catalog = options.catalog;
  const cacheKey = `${options.scope ?? ''}\0${options.unknownLabel}\0${trimmed}`;
  if (catalog !== undefined) {
    const bucket = catalogCache.get(catalog);
    const cached = bucket?.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  let result: ModelDisplayResult;
  if (catalog !== undefined && catalog.length > 0) {
    const { match, ambiguous } = findUnambiguousCatalogMatch(catalog, trimmed);
    if (ambiguous) {
      result = { label: options.unknownLabel, known: false, rawId: trimmed, ambiguous: true };
    } else if (match !== undefined) {
      const displayName = nonBlank(match.display_name);
      if (displayName !== undefined) {
        const collides = catalog.some(
          (other) => other.id !== match.id && nonBlank(other.display_name) === displayName,
        );
        const providerLabel = collides ? humanProviderLabel(match) : undefined;
        result = {
          label: providerLabel !== undefined ? `${displayName} (${providerLabel})` : displayName,
          known: true,
          rawId: trimmed,
          providerLabel,
        };
      } else {
        const publicAlias = !match.id.includes('/') ? KNOWN_PUBLIC_ALIASES[match.id] : KNOWN_PUBLIC_ALIASES[match.remote_id];
        result = publicAlias !== undefined
          ? { label: publicAlias, known: true, rawId: trimmed }
          : { label: options.unknownLabel, known: false, rawId: trimmed };
      }
    } else {
      const publicAlias = !trimmed.includes('/') ? KNOWN_PUBLIC_ALIASES[trimmed] : undefined;
      result = publicAlias !== undefined
        ? { label: publicAlias, known: true, rawId: trimmed }
        : { label: options.unknownLabel, known: false, rawId: trimmed };
    }
  } else {
    const publicAlias = !trimmed.includes('/') ? KNOWN_PUBLIC_ALIASES[trimmed] : undefined;
    result = publicAlias !== undefined
      ? { label: publicAlias, known: true, rawId: trimmed }
      : { label: options.unknownLabel, known: false, rawId: trimmed };
  }

  if (catalog !== undefined) {
    let bucket = catalogCache.get(catalog);
    if (bucket === undefined) {
      bucket = new Map();
      catalogCache.set(catalog, bucket);
    }
    bucket.set(cacheKey, result);
  }
  return result;
}
