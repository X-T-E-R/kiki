/**
 * Portable Spaces REST adapter and pure helpers.
 *
 * Delegates every HTTP call to the single canonical `klient.rest.portableSpaces`
 * facade over the authenticated local control client, normalizing `RPCError`
 * into `ApiError` so error codes (`40109`, `40428`, `40951`, `41004`, `40301`)
 * map cleanly through `@kiki/session-core/i18n`.
 */

import { useQuery } from '@tanstack/react-query';
import type { PortableSpacesFacade } from '@kiki/klient';
import { RPCError } from '@kiki/klient';
import { HTTP_TRANSPORT_TIMEOUT_REASON } from '@kiki/klient/http';
import {
  ErrorCode,
  type PortableSpaceCenterSourcesListResponse,
  type PortableSpaceDomain,
  type PortableSpaceEndpoint,
  type PortableSpaceFormat,
  type PortableSpaceInspectInput,
  type PortableSubscriptionScope,
} from '@kiki/protocol';
import { translate, type I18nKey } from '@kiki/session-core/i18n';

import { API_CODES, ApiError, type KikiClient } from './client';
import { isLocalOwnerRequiredError } from './peerAccess';

export type PortableSpacesApi = PortableSpacesFacade;

interface PortableSpacesOverrideClient {
  readonly portableSpaces?: PortableSpacesApi;
}

const clientScopes = new WeakMap<object, number>();
let nextClientScope = 0;

function clientScope(client: KikiClient | null): number | null {
  if (client === null) return null;
  let scope = clientScopes.get(client);
  if (scope === undefined) {
    scope = ++nextClientScope;
    clientScopes.set(client, scope);
  }
  return scope;
}

export const portableSpaceKeys = {
  all: ['portable-spaces'] as const,
  sources: (client: KikiClient | null) => ['portable-spaces', 'sources', clientScope(client)] as const,
  centerSources: (client: KikiClient | null) => ['portable-spaces', 'center-sources', clientScope(client)] as const,
  inspect: (client: KikiClient | null, endpoint: PortableSpaceEndpoint | null, unlockKey = '') =>
    ['portable-spaces', 'inspect', clientScope(client), endpoint === null ? null : endpointKey(endpoint), unlockKey] as const,
};

function toApiError(error: unknown): unknown {
  if (error instanceof RPCError) {
    const timedOut = error.reason === HTTP_TRANSPORT_TIMEOUT_REASON;
    return new ApiError({
      code: timedOut ? API_CODES.TIMEOUT : error.code,
      msg: timedOut ? error.message.replace('call timed out', translate('en', 'common.requestTimedOut')) : error.message,
      data: error.data ?? null,
      details: error.details,
      request_id: error.requestId,
      source: error.source,
      reason: error.reason,
    });
  }
  return error;
}

function wrapFacade(facade: PortableSpacesFacade): PortableSpacesFacade {
  const wrap = <Args extends readonly unknown[], Result>(
    fn: (...args: Args) => Promise<Result>,
  ): ((...args: Args) => Promise<Result>) => {
    return async (...args: Args) => {
      try {
        return await fn(...args);
      } catch (error) {
        throw toApiError(error);
      }
    };
  };

  return {
    listSources: wrap(facade.listSources.bind(facade)) as PortableSpacesFacade['listSources'],
    registerSource: wrap(facade.registerSource.bind(facade)),
    previewSubscribe: wrap(facade.previewSubscribe.bind(facade)),
    subscribe: wrap(facade.subscribe.bind(facade)) as PortableSpacesFacade['subscribe'],
    previewSource: wrap(facade.previewSource.bind(facade)),
    syncSubscription: wrap(facade.syncSubscription.bind(facade)) as PortableSpacesFacade['syncSubscription'],
    patchSource: wrap(facade.patchSource.bind(facade)),
    reorderSources: wrap(facade.reorderSources.bind(facade)),
    previewRemoveSource: wrap(facade.previewRemoveSource.bind(facade)),
    removeSource: wrap(facade.removeSource.bind(facade)),
    removeReviewedSource: wrap(facade.removeReviewedSource.bind(facade)),
    inspect: wrap(facade.inspect.bind(facade)),
    exportSpace: wrap(facade.exportSpace.bind(facade)),
    preview: wrap(facade.preview.bind(facade)),
    apply: wrap(facade.apply.bind(facade)),
    pack: wrap(facade.pack.bind(facade)),
    unpack: wrap(facade.unpack.bind(facade)),
    fork: wrap(facade.fork.bind(facade)),
    delta: wrap(facade.delta.bind(facade)),
    mutate: wrap(facade.mutate.bind(facade)),
    rekey: wrap(facade.rekey.bind(facade)),
    addRecipient: wrap(facade.addRecipient.bind(facade)),
  };
}

const wrappedFacades = new WeakMap<PortableSpacesFacade, PortableSpacesFacade>();

/**
 * Returns the canonical `klient.rest.portableSpaces` facade for the local
 * control client (or the test override seam when attached to a mock client).
 */
export function portableSpacesApi(client: KikiClient): PortableSpacesApi {
  const override = (client as PortableSpacesOverrideClient).portableSpaces;
  if (override !== undefined) return override;
  const facade = client.klient?.rest?.portableSpaces;
  if (facade === undefined) {
    throw new Error('Portable spaces require an HTTP connection to the local Kiki server.');
  }
  let wrapped = wrappedFacades.get(facade);
  if (wrapped === undefined) {
    wrapped = wrapFacade(facade);
    wrappedFacades.set(facade, wrapped);
  }
  return wrapped;
}

export function usePortableCenterSources(client: KikiClient | null) {
  return useQuery<PortableSpaceCenterSourcesListResponse>({
    queryKey: portableSpaceKeys.centerSources(client),
    queryFn: ({ signal }) => {
      if (client === null) throw new Error('The local space connection is not ready.');
      return portableSpacesApi(client).listSources({ view: 'center-v1', signal });
    },
    enabled: client !== null,
    staleTime: 20_000,
    retry: false,
  });
}

export function usePortableSources(client: KikiClient | null) {
  return useQuery({
    queryKey: portableSpaceKeys.sources(client),
    queryFn: ({ signal }) => {
      if (client === null) throw new Error('The local space connection is not ready.');
      return portableSpacesApi(client).listSources({ signal });
    },
    enabled: client !== null,
    staleTime: 20_000,
    retry: false,
  });
}

export function usePortableInspect(
  client: KikiClient | null,
  input: PortableSpaceInspectInput | null,
  options?: { readonly unlockNonce?: number; readonly enabled?: boolean },
) {
  const unlockKey = `${options?.unlockNonce ?? 0}:${input?.unlock?.passphrase ? 'pw' : ''}:${input?.unlock?.identity ? 'id' : ''}`;
  return useQuery({
    queryKey: portableSpaceKeys.inspect(client, input?.endpoint ?? null, unlockKey),
    queryFn: ({ signal }) => {
      if (client === null || input === null) throw new Error('Inspect input is unavailable.');
      return portableSpacesApi(client).inspect(input, { signal });
    },
    enabled: (options?.enabled ?? true) && client !== null && input !== null,
    staleTime: 10_000,
    retry: false,
  });
}

// ---- Error classification ----

export function extractPortableErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number') {
    return (error as { code: number }).code;
  }
  const text = error instanceof Error ? error.message : String(error ?? '');
  const match = /\(code (-?\d+)\)\s*$/u.exec(text);
  return match !== null ? Number(match[1]) : undefined;
}

export function isPortableUnlockRequiredError(error: unknown): boolean {
  return extractPortableErrorCode(error) === ErrorCode.PORTABLE_UNLOCK_REQUIRED;
}

export function isPortablePreviewStaleError(error: unknown): boolean {
  return extractPortableErrorCode(error) === ErrorCode.PORTABLE_PREVIEW_STALE;
}

export function isPortablePreviewExpiredError(error: unknown): boolean {
  return extractPortableErrorCode(error) === ErrorCode.PORTABLE_PREVIEW_EXPIRED;
}

export function isPortableOwnerDeniedError(error: unknown): boolean {
  return extractPortableErrorCode(error) === 40301 || isLocalOwnerRequiredError(error);
}

export function isPortableNotFoundError(error: unknown): boolean {
  return extractPortableErrorCode(error) === ErrorCode.PORTABLE_NOT_FOUND;
}

export function isPortableHostUnsupportedError(error: unknown): boolean {
  if (error instanceof Error && /404|not found/iu.test(error.message) && extractPortableErrorCode(error) === undefined) {
    return true;
  }
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 501) return true;
  }
  return false;
}

// ---- Scope & domain labels ----

export const PORTABLE_SUBSCRIPTION_SCOPE_LABEL_KEY: Record<PortableSubscriptionScope, I18nKey> = {
  models_providers: 'st.portable.scope.models_providers',
  extensions_search: 'st.portable.scope.extensions_search',
  agents_recipes: 'st.portable.scope.agents_recipes',
  personas: 'st.portable.scope.personas',
  instructions: 'st.portable.scope.instructions',
  settings: 'st.portable.scope.settings',
};

export interface PortableDomainGroup {
  readonly id: string;
  readonly labelKey: I18nKey;
  readonly domains: readonly PortableSpaceDomain[];
}

export const PORTABLE_DOMAIN_GROUPS: readonly PortableDomainGroup[] = [
  { id: 'config', labelKey: 'st.portable.domainGroup.config', domains: ['config'] },
  { id: 'instructions_agents', labelKey: 'st.portable.domainGroup.instructionsAgents', domains: ['instructions', 'agents'] },
  { id: 'recipes_personas', labelKey: 'st.portable.domainGroup.recipesPersonas', domains: ['recipes', 'personas'] },
  { id: 'mcp_plugins', labelKey: 'st.portable.domainGroup.mcpPlugins', domains: ['mcp', 'plugins'] },
  { id: 'skills', labelKey: 'st.portable.domainGroup.skills', domains: ['skills'] },
  { id: 'memories', labelKey: 'st.portable.domainGroup.memories', domains: ['memories'] },
  { id: 'appearance', labelKey: 'st.portable.domainGroup.appearance', domains: ['appearance'] },
];

export const DEFAULT_DOMAIN_GROUP_IDS: readonly string[] = PORTABLE_DOMAIN_GROUPS.map((group) => group.id);

export function expandDomainGroups(
  selectedGroupIds: ReadonlySet<string>,
  options: { readonly includeCredentials: boolean; readonly includeSessions: boolean },
): PortableSpaceDomain[] {
  const domains: PortableSpaceDomain[] = [];
  for (const group of PORTABLE_DOMAIN_GROUPS) {
    if (!selectedGroupIds.has(group.id)) continue;
    domains.push(...group.domains);
  }
  if (options.includeCredentials) domains.push('credentials');
  if (options.includeSessions) domains.push('sessions');
  return [...new Set(domains)];
}

export const PORTABLE_DOMAIN_LABEL_KEY: Record<PortableSpaceDomain, I18nKey> = {
  config: 'st.portable.domain.config',
  credentials: 'st.portable.domain.credentials',
  instructions: 'st.portable.domain.instructions',
  agents: 'st.portable.domain.agents',
  recipes: 'st.portable.domain.recipes',
  personas: 'st.portable.domain.personas',
  mcp: 'st.portable.domain.mcp',
  skills: 'st.portable.domain.skills',
  plugins: 'st.portable.domain.plugins',
  memories: 'st.portable.domain.memories',
  appearance: 'st.portable.domain.appearance',
  sessions: 'st.portable.domain.sessions',
};

// ---- Endpoint, URL masking, archive & Colab helpers ----

export function endpointKey(endpoint: PortableSpaceEndpoint): string {
  switch (endpoint.kind) {
    case 'live':
      return `live:${endpoint.spaceId}`;
    case 'dir':
      return `dir:${endpoint.path}`;
    case 'archive':
      return `archive:${endpoint.path}`;
    case 'git':
      return `git:${endpoint.repo}#${endpoint.ref ?? ''}#${endpoint.subpath ?? ''}`;
    case 'url':
      return `url:${endpoint.url}`;
  }
}

/**
 * Redacts long bearer path tokens and strips query/userinfo/fragment from a
 * subscription URL before displaying it in readonly surfaces or logs.
 */
export function maskSubscriptionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const maskedPath = parsed.pathname.split('/').map((segment) => {
      const match = /^([a-z0-9_-]{12,})(\.(?:kiki\.)?(?:tgz|tar\.gz|age))?$/iu.exec(segment);
      if (match === null) return segment;
      const token = match[1]!;
      const ext = match[2] ?? '';
      return `${token.slice(0, 4)}…${token.slice(-4)}${ext}`;
    }).join('/');
    return `${parsed.origin}${maskedPath}`;
  } catch {
    return rawUrl.replace(/\?.*$/u, '');
  }
}

export function extractSubscriptionOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.host || parsed.origin;
  } catch {
    return rawUrl;
  }
}

const ARCHIVE_EXTENSION_RE = /\.(?:kiki\.)?(?:tgz|tar\.gz|age)$/iu;

export function isSupportedPortableArchivePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  return trimmed.length > 0 && ARCHIVE_EXTENSION_RE.test(trimmed);
}

export function endpointSubtitle(endpoint: PortableSpaceEndpoint, gitBranch?: string): string {
  switch (endpoint.kind) {
    case 'live':
      return endpoint.spaceId;
    case 'dir':
    case 'archive':
      return endpoint.path;
    case 'git': {
      const ref = endpoint.ref ?? gitBranch;
      const suffix = [ref ? `@${ref}` : '', endpoint.subpath ? `/${endpoint.subpath.replace(/^\/+/u, '')}` : ''].join('');
      return `${endpoint.repo}${suffix}`;
    }
    case 'url':
      return maskSubscriptionUrl(endpoint.url);
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function endpointCliArg(endpoint: PortableSpaceEndpoint): string {
  switch (endpoint.kind) {
    case 'live':
      return endpoint.spaceId;
    case 'dir':
    case 'archive':
      return endpoint.path;
    case 'git': {
      const base = endpoint.repo;
      const subpath = endpoint.subpath?.replace(/^\/+/u, '');
      if (subpath) {
        const ref = endpoint.ref || 'HEAD';
        return `${base}#${ref}//${subpath}`;
      }
      return endpoint.ref ? `${base}#${endpoint.ref}` : base;
    }
    case 'url':
      return endpoint.url;
  }
}

/**
 * Generates a clean Colab quickstart shell snippet. Never embeds passphrases or
 * secret keys; encrypted sources read KIKI_AGE_PASSPHRASE (or KIKI_AGE_KEY)
 * from Colab Secrets / environment at runtime. `install.sh` passes `--yes`
 * internally to `kiki space apply`.
 */
export function buildColabCommand(options: {
  readonly source: PortableSpaceEndpoint;
  readonly overlay?: PortableSpaceEndpoint;
}): string {
  const lines = [
    '# Set KIKI_AGE_PASSPHRASE (or KIKI_AGE_KEY) in Colab Secrets if encrypted',
    'curl -fsSL https://raw.githubusercontent.com/X-T-E-R/kiki/kiki/scripts/install.sh | sh -s -- \\',
    '  --channel beta \\',
    `  --apply ${shellSingleQuote(endpointCliArg(options.source))} \\`,
  ];
  if (options.overlay !== undefined) {
    lines.push(`  --apply ${shellSingleQuote(endpointCliArg(options.overlay))} \\`);
  }
  lines.push('  --override');
  return lines.join('\n');
}

export function suggestExportDestination(mainPath: string, label: string, format: PortableSpaceFormat): string {
  const sep = mainPath.includes('\\') ? '\\' : '/';
  const trimmed = mainPath.replace(/[\\/]+$/u, '');
  const parent = trimmed.slice(0, Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/')));
  const root = parent === '' ? (trimmed || '.') : parent;
  const slug = label
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'space';
  const ext = format === 'age' ? '.kiki.age' : format === 'tgz' ? '.kiki.tgz' : '';
  return `${root}${sep}kiki-exports${sep}${slug}${ext}`;
}

export function suggestPackUnpackDestination(sourcePath: string, action: 'pack' | 'unpack'): string {
  const trimmed = sourcePath.trim().replace(/[\\/]+$/u, '');
  if (trimmed === '') return '';
  if (action === 'pack') {
    return trimmed.endsWith('.kiki.age') ? trimmed : `${trimmed}.kiki.age`;
  }
  const stripped = trimmed.replace(/\.(?:kiki\.age|kiki\.tgz|age|tgz)$/iu, '');
  return stripped === trimmed ? `${trimmed}-unpacked` : stripped;
}

export function parseScalarValue(raw: string, previous: string | number | boolean | null | undefined): unknown {
  const trimmed = raw.trim();
  if (typeof previous === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  if (typeof previous === 'number') {
    const parsed = Number(trimmed);
    if (trimmed !== '' && Number.isFinite(parsed)) return parsed;
  }
  if (trimmed === 'null' && previous === null) return null;
  return raw;
}
