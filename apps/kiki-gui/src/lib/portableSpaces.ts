/**
 * Portable Spaces REST client and pure helpers.
 *
 * Rides KikiClient's authenticated HTTP connection against `/api/spaces/portable/*`
 * and validates every response against `@kiki/protocol`.
 */

import { useQuery } from '@tanstack/react-query';

import {
  portableSpaceApplyReceiptSchema,
  portableSpaceExportReceiptSchema,
  portableSpaceInspectResultSchema,
  portableSpaceMutateReceiptSchema,
  portableSpacePreviewResultSchema,
  portableSpaceRemoveSourceResponseSchema,
  portableSpaceSourceRecordSchema,
  portableSpaceSourcesListResponseSchema,
  portableSpaceSubscriptionSyncResultSchema,
  type PortableSpaceApplyInput,
  type PortableSpaceApplyReceipt,
  type PortableSpaceDomain,
  type PortableSpaceEndpoint,
  type PortableSpaceExportInput,
  type PortableSpaceExportReceipt,
  type PortableSpaceForkInput,
  type PortableSpaceFormat,
  type PortableSpaceInspectInput,
  type PortableSpaceInspectResult,
  type PortableSpaceMutateInput,
  type PortableSpaceMutateReceipt,
  type PortableSpacePackUnpackInput,
  type PortableSpacePreviewInput,
  type PortableSpacePreviewResult,
  type PortableSpaceRegisterSourceInput,
  type PortableSpaceRekeyInput,
  type PortableSpaceRemoveSourceResponse,
  type PortableSpaceSourceRecord,
  type PortableSpaceSourcesListResponse,
  type PortableSpaceSubscribeInput,
  type PortableSpaceSubscriptionSyncInput,
  type PortableSpaceSubscriptionSyncResult,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { KikiClient } from './client';

export interface PortableSpacesApi {
  listSources(signal?: AbortSignal): Promise<PortableSpaceSourcesListResponse>;
  registerSource(input: PortableSpaceRegisterSourceInput, signal?: AbortSignal): Promise<PortableSpaceSourceRecord>;
  subscribe(input: PortableSpaceSubscribeInput, signal?: AbortSignal): Promise<PortableSpaceSubscriptionSyncResult>;
  syncSubscription(id: string, input?: Partial<PortableSpaceSubscriptionSyncInput>, signal?: AbortSignal): Promise<PortableSpaceSubscriptionSyncResult>;
  removeSource(id: string, signal?: AbortSignal): Promise<PortableSpaceRemoveSourceResponse>;
  inspect(input: PortableSpaceInspectInput, signal?: AbortSignal): Promise<PortableSpaceInspectResult>;
  exportSpace(input: PortableSpaceExportInput, signal?: AbortSignal): Promise<PortableSpaceExportReceipt>;
  preview(input: PortableSpacePreviewInput, signal?: AbortSignal): Promise<PortableSpacePreviewResult>;
  apply(input: PortableSpaceApplyInput, signal?: AbortSignal): Promise<PortableSpaceApplyReceipt>;
  pack(input: PortableSpacePackUnpackInput, signal?: AbortSignal): Promise<PortableSpaceExportReceipt>;
  unpack(input: PortableSpacePackUnpackInput, signal?: AbortSignal): Promise<PortableSpaceExportReceipt>;
  fork(input: PortableSpaceForkInput, signal?: AbortSignal): Promise<PortableSpaceExportReceipt>;
  mutate(input: PortableSpaceMutateInput, signal?: AbortSignal): Promise<PortableSpaceMutateReceipt>;
  rekey(input: PortableSpaceRekeyInput, signal?: AbortSignal): Promise<PortableSpaceInspectResult>;
}

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
  inspect: (client: KikiClient | null, endpoint: PortableSpaceEndpoint | null, unlockKey = '') =>
    ['portable-spaces', 'inspect', clientScope(client), endpoint === null ? null : endpointKey(endpoint), unlockKey] as const,
};

async function requestPortable<T>(
  client: KikiClient,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  schema: { parse(data: unknown): T },
  options: { readonly body?: unknown; readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly token?: string } = {},
): Promise<T> {
  const data = await client.requestApiJson<unknown>(method, path, {
    body: options.body,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 0,
    token: options.token,
  });
  return schema.parse(data);
}

export function portableSpacesApi(client: KikiClient, options?: { readonly token?: string }): PortableSpacesApi {
  const override = (client as PortableSpacesOverrideClient).portableSpaces;
  if (override !== undefined) return override;
  const token = options?.token;
  return {
    listSources: (signal) =>
      requestPortable(client, 'GET', '/spaces/portable/sources', portableSpaceSourcesListResponseSchema, { signal, token }),
    registerSource: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/sources', portableSpaceSourceRecordSchema, { body, signal, token }),
    subscribe: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/subscribe', portableSpaceSubscriptionSyncResultSchema, { body, signal, token }),
    syncSubscription: (id, body, signal) =>
      requestPortable(client, 'POST', `/spaces/portable/sources/${encodeURIComponent(id)}/sync`, portableSpaceSubscriptionSyncResultSchema, { body: body ?? {}, signal, token }),
    removeSource: (id, signal) =>
      requestPortable(client, 'DELETE', `/spaces/portable/sources/${encodeURIComponent(id)}`, portableSpaceRemoveSourceResponseSchema, { signal, token }),
    inspect: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/inspect', portableSpaceInspectResultSchema, { body, signal, token }),
    exportSpace: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/export', portableSpaceExportReceiptSchema, { body, signal, token }),
    preview: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/preview', portableSpacePreviewResultSchema, { body, signal, token }),
    apply: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/apply', portableSpaceApplyReceiptSchema, { body, signal, token }),
    pack: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/pack', portableSpaceExportReceiptSchema, { body, signal, token }),
    unpack: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/unpack', portableSpaceExportReceiptSchema, { body, signal, token }),
    fork: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/fork', portableSpaceExportReceiptSchema, { body, signal, token }),
    mutate: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/mutate', portableSpaceMutateReceiptSchema, { body, signal, token }),
    rekey: (body, signal) =>
      requestPortable(client, 'POST', '/spaces/portable/rekey', portableSpaceInspectResultSchema, { body, signal, token }),
  };
}

export function usePortableSources(client: KikiClient | null, token?: string) {
  return useQuery({
    queryKey: portableSpaceKeys.sources(client),
    queryFn: ({ signal }) => {
      if (client === null) throw new Error('The local space connection is not ready.');
      return portableSpacesApi(client, { token }).listSources(signal);
    },
    enabled: client !== null,
    staleTime: 20_000,
    retry: false,
  });
}

export function usePortableInspect(
  client: KikiClient | null,
  input: PortableSpaceInspectInput | null,
  options?: { readonly token?: string; readonly unlockNonce?: number },
) {
  const unlockKey = `${options?.unlockNonce ?? 0}:${input?.unlock?.passphrase ? 'pw' : ''}:${input?.unlock?.identity ? 'id' : ''}`;
  return useQuery({
    queryKey: portableSpaceKeys.inspect(client, input?.endpoint ?? null, unlockKey),
    queryFn: ({ signal }) => {
      if (client === null || input === null) throw new Error('Inspect input is unavailable.');
      return portableSpacesApi(client, { token: options?.token }).inspect(input, signal);
    },
    enabled: client !== null && input !== null,
    staleTime: 10_000,
    retry: false,
  });
}

// ---- Domain groups & labels ----

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

// ---- Endpoint & Colab helpers ----

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

function maskSubscriptionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const maskedPath = parsed.pathname.split('/').map((segment) => {
      const match = /^([a-z0-9_-]{16,})(\.(?:kiki\.)?(?:tgz|tar\.gz|age))?$/iu.exec(segment);
      if (match === null) return segment;
      const token = match[1]!;
      const ext = match[2] ?? '';
      return `${token.slice(0, 4)}…${token.slice(-4)}${ext}`;
    }).join('/');
    return `${parsed.origin}${maskedPath}`;
  } catch {
    return rawUrl;
  }
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
    'curl -fsSL https://github.com/X-T-E-R/kiki/releases/latest/download/install.sh | sh -s -- \\',
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
