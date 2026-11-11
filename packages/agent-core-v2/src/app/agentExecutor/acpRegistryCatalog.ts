import { z } from 'zod';

import { Error2, ErrorCodes } from '#/errors';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
export const ACP_REGISTRY_CACHE_SCOPE = 'acp-registry';
export const ACP_REGISTRY_CACHE_KEY = 'registry/v1/latest';
export const ACP_REGISTRY_MAX_AGENTS = 10_000;

const MAX_REGISTRY_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 20;
const REGISTRY_REQUEST_TIMEOUT_MS = 30_000;
const REGISTRY_SEARCH_MAX_AGE_MS = 5 * 60 * 1_000;

const EXACT_RUNNER_VERSION = 'v?[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
export const EXACT_NPX_PACKAGE = new RegExp(
  `^(?:@[^/@\\s]+/[^@\\s]+|[a-z0-9][a-z0-9._-]*)@${EXACT_RUNNER_VERSION}$`,
  'iu',
);
export const EXACT_UVX_PACKAGE = new RegExp(
  `^[a-z0-9][a-z0-9._-]*(?:@|==)${EXACT_RUNNER_VERSION}$`,
  'iu',
);

const boundedAgentIdSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/u);
const boundedNameSchema = z.string().trim().min(1).max(160);
const boundedVersionSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const boundedDescriptionSchema = z.string().max(1_024);
const boundedMetadataSchema = z.string().max(256);
const boundedArgumentSchema = z.string().max(1_024);
const packageCommandNameSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*$/iu);

export function isAcpRegistryHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

const httpsUrlSchema = z.string().refine(
  isAcpRegistryHttpsUrl,
  'ACP Registry URLs must use HTTPS without embedded credentials.',
);

const npxDistributionSchema = z.object({
  package: z.string().max(256).refine(
    (value) => EXACT_NPX_PACKAGE.test(value),
    'ACP Registry npx packages must include an exact version.',
  ),
  args: z.array(boundedArgumentSchema).max(64).optional(),
  env: z.record(boundedMetadataSchema, boundedArgumentSchema).optional(),
});

const uvxDistributionSchema = z.object({
  package: z.string().max(256).refine(
    (value) => EXACT_UVX_PACKAGE.test(value),
    'ACP Registry uvx packages must include an exact version.',
  ),
  args: z.array(boundedArgumentSchema).max(64).optional(),
  env: z.record(boundedMetadataSchema, boundedArgumentSchema).optional(),
});

const binaryTargetSchema = z.object({
  archive: httpsUrlSchema,
  cmd: boundedArgumentSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
  args: z.array(boundedArgumentSchema).max(64).optional(),
  env: z.record(boundedMetadataSchema, boundedArgumentSchema).optional(),
});

export const AcpRegistryAgentSchema = z.object({
  id: boundedAgentIdSchema,
  name: boundedNameSchema,
  version: boundedVersionSchema,
  description: boundedDescriptionSchema,
  authors: z.array(boundedMetadataSchema).max(16).optional(),
  license: z.string().max(128).optional(),
  website: httpsUrlSchema.optional(),
  repository: httpsUrlSchema.optional(),
  icon: httpsUrlSchema.optional(),
  distribution: z.object({
    binary: z.record(z.string(), binaryTargetSchema).optional(),
    npx: npxDistributionSchema.optional(),
    uvx: uvxDistributionSchema.optional(),
  }),
});

export type AcpRegistryAgent = z.infer<typeof AcpRegistryAgentSchema>;
export type AcpRegistryBinaryTarget = z.infer<typeof binaryTargetSchema>;
export type AcpRegistryDistributionKind = 'binary' | 'npx' | 'uvx';
export type AcpRegistryDistributionPreference = 'auto' | AcpRegistryDistributionKind;

const acpRegistryIndexEnvelopeSchema = z.object({
  version: boundedVersionSchema,
  agents: z.array(z.unknown()).max(ACP_REGISTRY_MAX_AGENTS),
});

export interface AcpRegistryIndex {
  readonly version: string;
  readonly agents: readonly AcpRegistryAgent[];
  readonly discardedCount: number;
}

export type AcpRegistryPlatformTarget =
  | 'darwin-aarch64'
  | 'darwin-x86_64'
  | 'linux-aarch64'
  | 'linux-x86_64'
  | 'windows-aarch64'
  | 'windows-x86_64';

export type AcpRegistryArchiveKind = 'raw' | 'tar_bz2' | 'tar_gz' | 'zip';

export interface ExactPackageSpec {
  readonly name: string;
  readonly version: string;
}

export interface ResolvedAcpRegistryDistribution {
  readonly kind: AcpRegistryDistributionKind;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly binaryTarget?: AcpRegistryBinaryTarget;
  readonly packageName?: string;
}

export interface AcpRegistrySearchInput {
  readonly query?: string;
  readonly limit?: number;
}

export interface AcpRegistrySearchResult {
  readonly version: string;
  readonly total: number;
  readonly agents: readonly AcpRegistryAgent[];
}

export interface AcpRegistryCatalogOptions {
  readonly registryUrl?: string;
  readonly cacheStore?: Pick<IAtomicDocumentStore, 'get' | 'set'>;
  readonly cacheScope?: string;
  readonly cacheKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: string,
): AcpRegistryPlatformTarget | undefined {
  const os = platform === 'darwin'
    ? 'darwin'
    : platform === 'linux'
      ? 'linux'
      : platform === 'win32'
        ? 'windows'
        : undefined;
  const arch = architecture === 'arm64' ? 'aarch64' : architecture === 'x64' ? 'x86_64' : undefined;
  return os !== undefined && arch !== undefined ? `${os}-${arch}` : undefined;
}

export function resolveAcpRegistryPlatformTargetCandidates(
  platformTarget: AcpRegistryPlatformTarget | undefined,
): readonly AcpRegistryPlatformTarget[] {
  if (platformTarget === undefined) return [];
  if (platformTarget === 'windows-aarch64') return ['windows-aarch64', 'windows-x86_64'];
  return [platformTarget];
}

export function parseNpxPackageSpec(packageSpec: string): ExactPackageSpec {
  const separator = packageSpec.lastIndexOf('@');
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + 1).replace(/^v/iu, ''),
  };
}

export function parseUvxPackageSpec(packageSpec: string): ExactPackageSpec {
  const equalsSeparator = packageSpec.lastIndexOf('==');
  const separator = equalsSeparator >= 0 ? equalsSeparator : packageSpec.lastIndexOf('@');
  const separatorLength = equalsSeparator >= 0 ? 2 : 1;
  return {
    name: packageSpec.slice(0, separator),
    version: packageSpec.slice(separator + separatorLength).replace(/^v/iu, ''),
  };
}

export function packageCommandCandidates(
  agent: Pick<AcpRegistryAgent, 'id'>,
  packageName: string,
): readonly string[] {
  const unscoped = packageName.split('/').pop() ?? packageName;
  return [...new Set(
    [agent.id, unscoped, unscoped.replace(/-acp$/u, '')].filter((candidate) =>
      packageCommandNameSchema.safeParse(candidate).success),
  )];
}

export function normalizeRegistryCommandPath(command: string): readonly string[] | undefined {
  const normalized = command.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/u.test(normalized) ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return segments;
}

export function validateArchiveEntries(output: string): boolean {
  return output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .every((entry) => entry === './' || normalizeRegistryCommandPath(entry) !== undefined);
}

export function acpRegistryArchiveKind(url: string): AcpRegistryArchiveKind {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.tar.gz') || pathname.endsWith('.tgz')) return 'tar_gz';
  if (pathname.endsWith('.tar.bz2') || pathname.endsWith('.tbz2')) return 'tar_bz2';
  if (pathname.endsWith('.zip')) return 'zip';
  return 'raw';
}

export function resolveAcpRegistryDistribution(input: {
  readonly agent: AcpRegistryAgent;
  readonly preference: AcpRegistryDistributionPreference;
  readonly platformTarget: AcpRegistryPlatformTarget | undefined;
}): ResolvedAcpRegistryDistribution | undefined {
  const { agent, platformTarget } = input;
  const binary = resolveAcpRegistryPlatformTargetCandidates(platformTarget)
    .map((candidate) => agent.distribution.binary?.[candidate])
    .find((entry) => entry !== undefined);
  const candidates: readonly AcpRegistryDistributionKind[] =
    input.preference === 'auto' ? ['binary', 'npx', 'uvx'] : [input.preference];
  for (const kind of candidates) {
    if (kind === 'binary' && binary !== undefined) {
      return {
        kind,
        args: binary.args ?? [],
        env: binary.env ?? {},
        binaryTarget: binary,
      };
    }
    if (kind === 'npx' && agent.distribution.npx !== undefined) {
      return {
        kind,
        args: agent.distribution.npx.args ?? [],
        env: agent.distribution.npx.env ?? {},
        packageName: agent.distribution.npx.package,
      };
    }
    if (kind === 'uvx' && agent.distribution.uvx !== undefined) {
      return {
        kind,
        args: agent.distribution.uvx.args ?? [],
        env: agent.distribution.uvx.env ?? {},
        packageName: agent.distribution.uvx.package,
      };
    }
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function searchRank(agent: AcpRegistryAgent, query: string): number | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return 100;
  const id = agent.id.toLowerCase();
  const name = agent.name.toLowerCase();
  const authors = (agent.authors ?? []).join(' ').toLowerCase();
  const description = agent.description.toLowerCase();
  const terms = normalized.split(/\s+/u);
  if (id === normalized || name === normalized) return 0;
  if (id.startsWith(normalized) || name.startsWith(normalized)) return 10;
  const identityTokens = `${id} ${name}`.split(/[^a-z0-9]+/u).filter(Boolean);
  if (terms.every((term) => identityTokens.some((token) => token.startsWith(term)))) return 20;
  if (terms.every((term) => id.includes(term) || name.includes(term))) return 30;
  if (terms.every((term) => authors.includes(term))) return 40;
  if (terms.every((term) => `${id} ${name} ${authors} ${description}`.includes(term))) return 50;
  return undefined;
}

export function searchAcpRegistryAgents(
  index: Pick<AcpRegistryIndex, 'version' | 'agents'>,
  input: AcpRegistrySearchInput = {},
): AcpRegistrySearchResult {
  const query = input.query ?? '';
  const limit = Math.max(1, Math.min(ACP_REGISTRY_MAX_AGENTS, input.limit ?? DEFAULT_SEARCH_LIMIT));
  const ranked = index.agents
    .flatMap((agent) => {
      const rank = searchRank(agent, query);
      return rank === undefined ? [] : [{ agent, rank }];
    })
    .toSorted((left, right) =>
      left.rank - right.rank ||
      compareText(left.agent.name.toLowerCase(), right.agent.name.toLowerCase()) ||
      compareText(left.agent.id, right.agent.id));
  return {
    version: index.version,
    total: ranked.length,
    agents: ranked.slice(0, limit).map((entry) => entry.agent),
  };
}

export function decodeAcpRegistryIndexObject(raw: unknown): AcpRegistryIndex {
  const envelope = acpRegistryIndexEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ACP Registry returned an invalid index.');
  }
  const agents: AcpRegistryAgent[] = [];
  for (const candidate of envelope.data.agents) {
    const parsed = AcpRegistryAgentSchema.safeParse(candidate);
    if (parsed.success) agents.push(parsed.data);
  }
  return {
    version: envelope.data.version,
    agents,
    discardedCount: envelope.data.agents.length - agents.length,
  };
}

export function decodeAcpRegistryIndex(text: string): AcpRegistryIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ACP Registry returned invalid JSON.', { cause });
  }
  return decodeAcpRegistryIndexObject(raw);
}

async function readBoundedUtf8(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error2(ErrorCodes.REQUEST_INVALID, `ACP Registry index exceeds ${String(maxBytes)} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch (cause) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'ACP Registry index is not valid UTF-8.', { cause });
  }
}

export class AcpRegistryCatalog {
  readonly #registryUrl: string;
  readonly #cacheStore: AcpRegistryCatalogOptions['cacheStore'];
  readonly #cacheScope: string;
  readonly #cacheKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cached: AcpRegistryIndex | undefined;
  #fetchedAtMs: number | undefined;
  #inFlight: Promise<AcpRegistryIndex> | undefined;

  constructor(options: AcpRegistryCatalogOptions = {}) {
    this.#registryUrl = options.registryUrl ?? ACP_REGISTRY_URL;
    this.#cacheStore = options.cacheStore;
    this.#cacheScope = options.cacheScope ?? ACP_REGISTRY_CACHE_SCOPE;
    this.#cacheKey = options.cacheKey ?? ACP_REGISTRY_CACHE_KEY;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async fetchIndex(options: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {}): Promise<AcpRegistryIndex> {
    const now = this.#now();
    if (
      options.forceRefresh !== true &&
      this.#cached !== undefined &&
      this.#fetchedAtMs !== undefined &&
      now >= this.#fetchedAtMs &&
      now - this.#fetchedAtMs < REGISTRY_SEARCH_MAX_AGE_MS
    ) {
      return this.#cached;
    }
    if (this.#inFlight !== undefined && options.forceRefresh !== true) return this.#inFlight;
    const flight = this.#refresh(options.signal).finally(() => {
      if (this.#inFlight === flight) this.#inFlight = undefined;
    });
    if (options.forceRefresh !== true) this.#inFlight = flight;
    return flight;
  }

  async search(input: AcpRegistrySearchInput = {}, options?: { readonly signal?: AbortSignal }): Promise<AcpRegistrySearchResult> {
    const index = await this.fetchIndex({ signal: options?.signal });
    return searchAcpRegistryAgents(index, input);
  }

  async resolveAgent(
    agentId: string,
    options: {
      readonly preference?: AcpRegistryDistributionPreference;
      readonly platform?: NodeJS.Platform;
      readonly arch?: string;
      readonly forceRefresh?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<{ readonly agent: AcpRegistryAgent; readonly distribution: ResolvedAcpRegistryDistribution }> {
    if (!boundedAgentIdSchema.safeParse(agentId).success) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Invalid ACP Registry agent id "${agentId}"`);
    }
    const index = await this.fetchIndex({ forceRefresh: options.forceRefresh, signal: options.signal });
    const agent = index.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, `ACP Registry agent "${agentId}" was not found`);
    }
    const platformTarget = resolveAcpRegistryPlatformTarget(
      options.platform ?? process.platform,
      options.arch ?? process.arch,
    );
    const distribution = resolveAcpRegistryDistribution({
      agent,
      preference: options.preference ?? 'auto',
      platformTarget,
    });
    if (distribution === undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `ACP Registry agent "${agentId}" has no compatible distribution for ${platformTarget ?? 'this platform'}`,
      );
    }
    return { agent, distribution };
  }

  async #refresh(signal: AbortSignal | undefined): Promise<AcpRegistryIndex> {
    if (!isAcpRegistryHttpsUrl(this.#registryUrl)) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'ACP Registry index URL must use HTTPS without embedded credentials.');
    }
    try {
      const timeoutSignal = AbortSignal.timeout(REGISTRY_REQUEST_TIMEOUT_MS);
      const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      const response = await this.#fetch(this.#registryUrl, { signal: requestSignal });
      if (!response.ok) {
        throw new Error2(
          ErrorCodes.INTERNAL,
          `Could not fetch ACP Registry index from ${this.#registryUrl} (HTTP ${String(response.status)}).`,
        );
      }
      const text = await readBoundedUtf8(response, MAX_REGISTRY_BYTES);
      const decoded = decodeAcpRegistryIndex(text);
      await this.#writeCache(decoded);
      this.#cached = decoded;
      this.#fetchedAtMs = this.#now();
      return decoded;
    } catch (networkError) {
      const cached = await this.#readCache();
      if (cached !== undefined) {
        this.#cached = cached;
        this.#fetchedAtMs = undefined;
        return cached;
      }
      throw networkError;
    }
  }

  async #readCache(): Promise<AcpRegistryIndex | undefined> {
    if (this.#cacheStore === undefined) return undefined;
    try {
      const raw = await this.#cacheStore.get<unknown>(this.#cacheScope, this.#cacheKey);
      if (raw === undefined) return undefined;
      return decodeAcpRegistryIndexObject(raw);
    } catch {
      return undefined;
    }
  }

  async #writeCache(index: AcpRegistryIndex): Promise<void> {
    if (this.#cacheStore === undefined) return;
    try {
      await this.#cacheStore.set(this.#cacheScope, this.#cacheKey, index);
    } catch {
      return;
    }
  }
}
