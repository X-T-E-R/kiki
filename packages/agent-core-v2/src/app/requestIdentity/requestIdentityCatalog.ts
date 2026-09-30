import { execFile } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { promisify } from 'node:util';

import {
  requestIdentityManifestSchema,
  requestIdentityProfileDraftSchema,
  type RequestIdentityObservation,
  type RequestIdentityPreview,
  type RequestIdentityProfile,
  type RequestIdentityProfileDraft,
  type RequestIdentityTrack,
  type RequestIdentityTrackCheck,
  type RequestIdentityTrackId,
  type RequestIdentityTrackRevision,
  type RequestIdentityUpdateSource,
  type RequestIdentityUsage,
} from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2 } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import {
  MODELS_SECTION,
  PROVIDERS_SECTION,
  REQUEST_IDENTITY_SECTION,
} from '#/app/kosongConfig/configSection';
import type { ModelsSection } from '#/kosong/model/model';
import type { ProvidersSection } from '#/kosong/provider/provider';
import { LifecycleScope } from '#/app/scopes';
import type { Protocol } from '#/kosong/protocol/protocol';
import { RequestIdentityErrors } from '#/kosong/requestIdentity/errors';
import {
  builtinRequestIdentityProfileAxes,
  registerRequestIdentityProfileLookup,
  requestIdentityToWire,
  resolveRequestIdentityLayersWith,
  type RequestIdentityPolicy,
  type RequestIdentityProfileAxes,
  type ResolvedRequestIdentityPolicy,
} from '#/kosong/requestIdentity/requestIdentityPolicy';
import {
  BUILTIN_REQUEST_IDENTITY_PROFILES,
  REQUEST_IDENTITY_TRACK_SEEDS,
  renderRequestIdentityProfile,
  requestIdentityProfileAxes,
  validateRequestIdentityProfileDraft,
  type RenderedRequestIdentityProfile,
} from '#/kosong/requestIdentity/requestIdentityProfile';
import { projectRequestIdentity } from '#/kosong/requestIdentity/requestIdentityProjector';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

const DOCUMENT_KEY = 'request-identity-catalog.json';
const HISTORY_LIMIT = 10;
const OBSERVATION_LIMIT = 20;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REMOTE_BYTES = 256 * 1024;
const execFileAsync = promisify(execFile);

interface StoredTrack {
  current?: RequestIdentityTrackRevision;
  candidate?: RequestIdentityTrackRevision;
  history: RequestIdentityTrackRevision[];
  pinned: boolean;
  lastCheck?: RequestIdentityTrackCheck;
}

interface CatalogDocument {
  readonly version: 1;
  profiles: RequestIdentityProfile[];
  tracks: Partial<Record<RequestIdentityTrackId, StoredTrack>>;
  manifestUrl?: string;
}

/** Fetches one upstream document; injectable so tests never touch the network. */
export type RequestIdentityFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Runs `<command> --version`; injectable so tests never spawn processes. */
export type RequestIdentityCliProbe = (command: string) => Promise<string>;

export interface RequestIdentityObservationInput {
  readonly providerId: string;
  readonly model: string;
  readonly protocol: string;
  readonly policy: ResolvedRequestIdentityPolicy;
  readonly sessionId: string;
  readonly agentId: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly cacheKey?: string;
  readonly suppressedUserAgent: boolean;
}

export interface IRequestIdentityCatalog {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  /** Synchronous lookup used while resolving layers; custom ids resolve once `ready` settles. */
  profileAxes(id: string): RequestIdentityProfileAxes | undefined;
  resolveLayers(...layers: readonly (RequestIdentityPolicy | undefined)[]): ResolvedRequestIdentityPolicy;
  render(policy: ResolvedRequestIdentityPolicy, model: string): RenderedRequestIdentityProfile | undefined;
  recordObservation(input: RequestIdentityObservationInput): void;
  listProfiles(): Promise<RequestIdentityProfile[]>;
  listTracks(): Promise<RequestIdentityTrack[]>;
  manifestUrl(): Promise<string | null>;
  usage(): Promise<RequestIdentityUsage[]>;
  observations(): RequestIdentityObservation[];
  preview(input: { profile?: string; draft?: RequestIdentityProfileDraft; protocol: Protocol; model: string }): Promise<RequestIdentityPreview>;
  duplicateProfile(from: string, label?: string): Promise<RequestIdentityProfile>;
  updateProfile(id: string, draft: RequestIdentityProfileDraft): Promise<RequestIdentityProfile>;
  deleteProfile(id: string): Promise<void>;
  checkTrack(id: RequestIdentityTrackId, source: RequestIdentityUpdateSource): Promise<RequestIdentityTrack>;
  applyCandidate(id: RequestIdentityTrackId, version: string): Promise<RequestIdentityTrack>;
  dismissCandidate(id: RequestIdentityTrackId): Promise<RequestIdentityTrack>;
  rollbackTrack(id: RequestIdentityTrackId): Promise<RequestIdentityTrack>;
  resetTrack(id: RequestIdentityTrackId): Promise<RequestIdentityTrack>;
  pinTrack(id: RequestIdentityTrackId, pinned: boolean): Promise<RequestIdentityTrack>;
  setManifestUrl(url: string | null): Promise<void>;
}

export const IRequestIdentityCatalog: ServiceIdentifier<IRequestIdentityCatalog> =
  createDecorator<IRequestIdentityCatalog>('requestIdentityCatalog');

export class RequestIdentityCatalog extends Disposable implements IRequestIdentityCatalog {
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  private document: CatalogDocument = { version: 1, profiles: [], tracks: {} };
  private chain: Promise<unknown> = Promise.resolve();
  private readonly recent: RequestIdentityObservation[] = [];
  private readonly fetchImpl: RequestIdentityFetch;
  private readonly cliProbe: RequestIdentityCliProbe;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IConfigService private readonly config: IConfigService,
    fetchImpl?: RequestIdentityFetch,
    cliProbe?: RequestIdentityCliProbe,
  ) {
    super();
    this.fetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, { ...init, redirect: 'error' }));
    this.cliProbe = cliProbe ?? defaultCliProbe;
    this.ready = this.load();
    this._register({ dispose: registerRequestIdentityProfileLookup((id) => this.profileAxes(id)) });
  }

  profileAxes(id: string): RequestIdentityProfileAxes | undefined {
    const builtin = builtinRequestIdentityProfileAxes(id);
    if (builtin !== undefined) return builtin;
    const profile = this.document.profiles.find((candidate) => candidate.id === id);
    return profile === undefined ? undefined : requestIdentityProfileAxes(profile);
  }

  resolveLayers(...layers: readonly (RequestIdentityPolicy | undefined)[]): ResolvedRequestIdentityPolicy {
    return resolveRequestIdentityLayersWith((id) => this.profileAxes(id), ...layers);
  }

  render(policy: ResolvedRequestIdentityPolicy, model: string): RenderedRequestIdentityProfile | undefined {
    const profile = this.profile(policy.profile);
    if (profile === undefined) return undefined;
    return renderRequestIdentityProfile(profile, this.trackCurrent(profile.track), this.renderContext(model));
  }

  recordObservation(input: RequestIdentityObservationInput): void {
    this.recent.unshift({
      at: new Date().toISOString(),
      provider_id: input.providerId,
      model: input.model,
      protocol: input.protocol,
      profile: input.policy.profile,
      preset: input.policy.preset,
      session_id: input.sessionId,
      agent_id: input.agentId,
      headers: Object.entries(input.headers ?? {})
        .filter(([name]) => !name.toLowerCase().startsWith('x-kiki-'))
        .map(([name, value]) => ({ name, value })),
      params: { ...input.params },
      cache_key: input.cacheKey,
      suppressed_user_agent: input.suppressedUserAgent,
    });
    this.recent.splice(OBSERVATION_LIMIT);
  }

  observations(): RequestIdentityObservation[] {
    return this.recent.map((entry) => structuredClone(entry));
  }

  async listProfiles(): Promise<RequestIdentityProfile[]> {
    await this.ready;
    return [...BUILTIN_REQUEST_IDENTITY_PROFILES, ...this.document.profiles].map((profile) => structuredClone(profile));
  }

  async listTracks(): Promise<RequestIdentityTrack[]> {
    await this.ready;
    return REQUEST_IDENTITY_TRACK_SEEDS.map((seed) => this.trackView(seed.id));
  }

  async manifestUrl(): Promise<string | null> {
    await this.ready;
    return this.document.manifestUrl ?? null;
  }

  async usage(): Promise<RequestIdentityUsage[]> {
    await this.ready;
    const global = this.config.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION);
    const providers = this.config.get<ProvidersSection | undefined>(PROVIDERS_SECTION) ?? {};
    const models = this.config.get<ModelsSection | undefined>(MODELS_SECTION) ?? {};
    const rows: RequestIdentityUsage[] = [this.usageRow({ scope: 'global', label: 'global' }, [global])];
    for (const [providerId, provider] of Object.entries(providers)) {
      rows.push(this.usageRow({ scope: 'provider', provider_id: providerId, label: providerId }, [global, provider.requestIdentity]));
    }
    for (const [modelId, model] of Object.entries(models)) {
      const providerId = model.provider ?? model.providerId;
      const provider = providerId === undefined ? undefined : providers[providerId];
      rows.push(this.usageRow(
        { scope: 'model', provider_id: providerId, model_id: modelId, label: model.displayName ?? modelId },
        [global, provider?.requestIdentity, model.requestIdentity],
      ));
    }
    return rows;
  }

  async preview(input: {
    profile?: string;
    draft?: RequestIdentityProfileDraft;
    protocol: Protocol;
    model: string;
  }): Promise<RequestIdentityPreview> {
    await this.ready;
    let profile: RequestIdentityProfile;
    if (input.draft !== undefined) {
      const draft = requestIdentityProfileDraftSchema.parse(input.draft);
      validateRequestIdentityProfileDraft(draft);
      profile = { ...draft, id: 'custom:preview', builtin: false };
    } else {
      profile = this.requireProfile(input.profile ?? '');
    }
    const rendered = renderRequestIdentityProfile(profile, this.trackCurrent(profile.track), this.renderContext(input.model));
    const base: RequestIdentityPreview = {
      headers: [],
      params: {},
      version: rendered.version,
      version_origin: rendered.versionOrigin,
      suppressed_user_agent: profile.base_preset === 'none',
    };
    let policy: ResolvedRequestIdentityPolicy;
    try {
      policy = resolveRequestIdentityLayersWith(
        (id) => (id === profile.id ? requestIdentityProfileAxes(profile) : this.profileAxes(id)),
        { profile: profile.id },
      );
      const projection = projectRequestIdentity({
        policy,
        protocol: input.protocol,
        model: input.model,
        rawSessionId: PREVIEW_SNAPSHOT.sharedSessionId,
        rawAgentId: 'main',
        isKimiProvider: true,
        snapshot: PREVIEW_SNAPSHOT,
        runtimeVersion: this.bootstrap.clientIdentity.version,
        platform: this.bootstrap.platform,
        arch: this.bootstrap.arch,
        profile: rendered,
      });
      const profileNames = new Set([
        ...rendered.headers.map((header) => header.name.toLowerCase()),
        ...(rendered.userAgent === undefined ? [] : ['user-agent']),
      ]);
      const headers = Object.entries(projection.headers ?? {})
        .filter(([name]) => !name.toLowerCase().startsWith('x-kiki-'))
        .map(([name, value]) => ({
          name,
          value,
          kind: PER_REQUEST_HEADERS.has(name.toLowerCase()) ? ('per_request' as const) : ('static' as const),
          origin: profileNames.has(name.toLowerCase()) ? ('profile' as const) : ('lineage' as const),
        }));
      const params: Record<string, string | number | boolean> = { ...projection.params };
      if (projection.cacheKey !== undefined) {
        params[input.protocol === 'anthropic' ? 'metadata.user_id' : 'prompt_cache_key'] = projection.cacheKey;
      }
      const metadata = projection.wire?.responsesClientMetadata;
      if (metadata !== undefined) params['client_metadata'] = JSON.stringify(metadata);
      return {
        ...base,
        headers,
        params,
        suppressed_user_agent: projection.wire?.suppressUserAgent === true,
      };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async duplicateProfile(from: string, label?: string): Promise<RequestIdentityProfile> {
    return this.mutate(() => {
      const source = this.requireProfile(from);
      const now = new Date().toISOString();
      const profile: RequestIdentityProfile = {
        ...structuredClone(source),
        id: this.nextCustomId(source.id),
        builtin: false,
        label: label ?? `${source.label} (copy)`,
        duplicated_from: source.id,
        created_at: now,
        updated_at: now,
      };
      if (source.builtin && source.version.mode === 'track') {
        const current = this.trackCurrent(source.track);
        if (current?.user_agent !== undefined) profile.user_agent = current.user_agent;
        for (const header of current?.headers ?? []) {
          const index = profile.headers.findIndex((item) => item.name.toLowerCase() === header.name.toLowerCase());
          if (index === -1) profile.headers.push({ ...header });
          else profile.headers[index] = { ...header };
        }
      }
      this.document.profiles.push(profile);
      return structuredClone(profile);
    });
  }

  async updateProfile(id: string, draft: RequestIdentityProfileDraft): Promise<RequestIdentityProfile> {
    const parsed = requestIdentityProfileDraftSchema.parse(draft);
    validateRequestIdentityProfileDraft(parsed);
    return this.mutate(() => {
      const index = this.document.profiles.findIndex((profile) => profile.id === id);
      if (index === -1) {
        if (this.profile(id)?.builtin === true) throw invalid('built-in identities are read-only; duplicate one to edit it');
        throw notFound(id);
      }
      const current = this.document.profiles[index]!;
      const next: RequestIdentityProfile = {
        ...parsed,
        id,
        builtin: false,
        duplicated_from: current.duplicated_from,
        created_at: current.created_at,
        updated_at: new Date().toISOString(),
      };
      this.document.profiles[index] = next;
      return structuredClone(next);
    });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.mutate(() => {
      const index = this.document.profiles.findIndex((profile) => profile.id === id);
      if (index === -1) throw this.profile(id)?.builtin === true ? invalid('built-in identities cannot be deleted') : notFound(id);
      const users = this.referencingLayers(id);
      if (users.length > 0) {
        throw new Error2(
          RequestIdentityErrors.codes.REQUEST_IDENTITY_CONFLICT,
          `identity ${id} is still used by ${users.join(', ')}`,
        );
      }
      this.document.profiles.splice(index, 1);
    });
  }

  /**
   * Read one upstream source and stage the result as a candidate. Nothing a request sends changes
   * until `applyCandidate`; a pinned track still records the check so the page can show it.
   */
  async checkTrack(id: RequestIdentityTrackId, source: RequestIdentityUpdateSource): Promise<RequestIdentityTrack> {
    await this.ready;
    const seed = requireSeed(id);
    const at = new Date().toISOString();
    let revision: RequestIdentityTrackRevision | undefined;
    let error: string | undefined;
    try {
      revision = await this.readSource(seed, source, at);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    return this.mutate(() => {
      const track = this.storedTrack(id);
      track.lastCheck = { source, at, ok: revision !== undefined, version: revision?.version, error };
      const current = track.current ?? seed.builtin;
      if (revision !== undefined) track.candidate = sameRevision(revision, current) ? undefined : revision;
      return this.trackView(id);
    });
  }

  async applyCandidate(id: RequestIdentityTrackId, version: string): Promise<RequestIdentityTrack> {
    return this.mutate(() => {
      const track = this.storedTrack(id);
      if (track.pinned) throw invalid('unpin the track before applying an update');
      if (track.candidate === undefined || track.candidate.version !== version) {
        throw new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_CONFLICT, 'the checked version changed; check again');
      }
      this.pushHistory(track, track.current ?? requireSeed(id).builtin);
      track.current = { ...track.candidate, at: new Date().toISOString() };
      track.candidate = undefined;
      return this.trackView(id);
    });
  }

  async dismissCandidate(id: RequestIdentityTrackId): Promise<RequestIdentityTrack> {
    return this.mutate(() => {
      this.storedTrack(id).candidate = undefined;
      return this.trackView(id);
    });
  }

  async rollbackTrack(id: RequestIdentityTrackId): Promise<RequestIdentityTrack> {
    return this.mutate(() => {
      const track = this.storedTrack(id);
      if (track.pinned) throw invalid('unpin the track before rolling back');
      const previous = track.history.shift();
      if (previous === undefined) throw invalid('there is no earlier version to roll back to');
      track.current = previous.origin === 'builtin' ? undefined : previous;
      return this.trackView(id);
    });
  }

  async resetTrack(id: RequestIdentityTrackId): Promise<RequestIdentityTrack> {
    return this.mutate(() => {
      const track = this.storedTrack(id);
      if (track.pinned) throw invalid('unpin the track before resetting it');
      if (track.current !== undefined) {
        this.pushHistory(track, track.current);
        track.current = undefined;
      }
      return this.trackView(id);
    });
  }

  async pinTrack(id: RequestIdentityTrackId, pinned: boolean): Promise<RequestIdentityTrack> {
    return this.mutate(() => {
      this.storedTrack(id).pinned = pinned;
      return this.trackView(id);
    });
  }

  async setManifestUrl(url: string | null): Promise<void> {
    if (url !== null && !url.startsWith('https://')) throw invalid('manifest URL must use https');
    await this.mutate(() => {
      this.document.manifestUrl = url ?? undefined;
    });
  }

  private async load(): Promise<void> {
    const stored = await this.docs.get<unknown>(this.bootstrap.scope('store'), DOCUMENT_KEY);
    this.document = parseDocument(stored);
  }

  private async persist(): Promise<void> {
    await this.docs.set(this.bootstrap.scope('store'), DOCUMENT_KEY, this.document);
  }

  private async mutate<T>(change: () => T): Promise<T> {
    const run = this.chain.then(async () => {
      await this.ready;
      const before = structuredClone(this.document);
      try {
        const result = change();
        await this.persist();
        return result;
      } catch (error) {
        this.document = before;
        throw error;
      }
    });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private profile(id: string): RequestIdentityProfile | undefined {
    return BUILTIN_REQUEST_IDENTITY_PROFILES.find((profile) => profile.id === id)
      ?? this.document.profiles.find((profile) => profile.id === id);
  }

  private requireProfile(id: string): RequestIdentityProfile {
    const profile = this.profile(id);
    if (profile === undefined) throw notFound(id);
    return structuredClone(profile);
  }

  private nextCustomId(sourceId: string): string {
    const stem = sourceId.replace(/^custom:/u, '').replaceAll(/[^a-z0-9_-]/gu, '').slice(0, 40) || 'identity';
    for (let n = 1; ; n += 1) {
      const id = `custom:${stem}-${String(n)}`;
      if (this.profile(id) === undefined) return id;
    }
  }

  private referencingLayers(id: string): string[] {
    const users: string[] = [];
    if (this.config.get<RequestIdentityPolicy | undefined>(REQUEST_IDENTITY_SECTION)?.profile === id) users.push('the global default');
    for (const [providerId, provider] of Object.entries(this.config.get<ProvidersSection | undefined>(PROVIDERS_SECTION) ?? {})) {
      if (provider.requestIdentity?.profile === id) users.push(`provider ${providerId}`);
    }
    for (const [modelId, model] of Object.entries(this.config.get<ModelsSection | undefined>(MODELS_SECTION) ?? {})) {
      if (model.requestIdentity?.profile === id) users.push(`model ${modelId}`);
    }
    return users;
  }

  private usageRow(
    row: Pick<RequestIdentityUsage, 'scope' | 'provider_id' | 'model_id' | 'label'>,
    layers: readonly (RequestIdentityPolicy | undefined)[],
  ): RequestIdentityUsage {
    const authored = layers.at(-1);
    try {
      const resolved = this.resolveLayers(...layers);
      return {
        ...row,
        authored: requestIdentityToWire(authored),
        effective_profile: resolved.profile,
        effective_preset: resolved.preset,
      };
    } catch (error) {
      return {
        ...row,
        authored: requestIdentityToWire(authored),
        effective_profile: null,
        effective_preset: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private storedTrack(id: RequestIdentityTrackId): StoredTrack {
    requireSeed(id);
    this.document.tracks[id] ??= { history: [], pinned: false };
    return this.document.tracks[id];
  }

  private trackCurrent(id: RequestIdentityTrackId | null): RequestIdentityTrackRevision | undefined {
    if (id === null) return undefined;
    return this.document.tracks[id]?.current ?? REQUEST_IDENTITY_TRACK_SEEDS.find((seed) => seed.id === id)?.builtin;
  }

  private trackView(id: RequestIdentityTrackId): RequestIdentityTrack {
    const seed = requireSeed(id);
    const stored = this.document.tracks[id];
    return structuredClone({
      id,
      npm_package: seed.npmPackage,
      cli_command: seed.cliCommand,
      current: stored?.current ?? seed.builtin,
      builtin: seed.builtin,
      candidate: stored?.candidate ?? null,
      history: stored?.history ?? [],
      pinned: stored?.pinned ?? false,
      last_check: stored?.lastCheck ?? null,
    });
  }

  private pushHistory(track: StoredTrack, revision: RequestIdentityTrackRevision): void {
    track.history.unshift(structuredClone(revision));
    track.history.splice(HISTORY_LIMIT);
  }

  private renderContext(model: string) {
    return {
      kikiVersion: this.bootstrap.clientIdentity.version,
      model,
      platform: this.bootstrap.platform,
      arch: this.bootstrap.arch,
      osRelease: osRelease(),
    };
  }

  private async readSource(
    seed: (typeof REQUEST_IDENTITY_TRACK_SEEDS)[number],
    source: RequestIdentityUpdateSource,
    at: string,
  ): Promise<RequestIdentityTrackRevision> {
    if (source === 'local_cli') {
      const output = await this.cliProbe(seed.cliCommand);
      const version = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(output)?.[1];
      if (version === undefined) throw new Error(`${seed.cliCommand} --version printed no version`);
      return { version, origin: 'local_cli', source_detail: `${seed.cliCommand} --version`, at };
    }
    if (source === 'npm') {
      const url = `https://registry.npmjs.org/${seed.npmPackage.replace('/', '%2F')}/latest`;
      const body = await this.fetchJson(url);
      return { version: parseNpmRelease(seed.npmPackage, body), origin: 'npm', source_detail: seed.npmPackage, at };
    }
    const manifestUrl = this.document.manifestUrl;
    if (manifestUrl === undefined) throw new Error('no manifest URL is configured');
    const manifest = requestIdentityManifestSchema.safeParse(await this.fetchJson(manifestUrl));
    if (!manifest.success) throw new Error(`manifest rejected: ${manifest.error.issues[0]?.message ?? 'invalid shape'}`);
    const entry = manifest.data.tracks[seed.id];
    if (entry === undefined) throw new Error(`manifest has no entry for ${seed.id}`);
    const draftCheck = { ...BUILTIN_REQUEST_IDENTITY_PROFILES[0]!, user_agent: entry.user_agent ?? '', headers: entry.headers ?? [] };
    validateRequestIdentityProfileDraft(draftCheck);
    return {
      version: entry.version,
      user_agent: entry.user_agent,
      headers: entry.headers,
      origin: 'manifest',
      source_detail: manifestUrl,
      at,
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`);
      const text = await response.text();
      if (text.length > MAX_REMOTE_BYTES) throw new Error(`${url} response is too large`);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}

const PER_REQUEST_HEADERS = new Set([
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-window-id',
  'x-codex-turn-metadata',
  'x-codex-parent-thread-id',
  'x-grok-conv-id',
  'x-grok-session-id',
  'x-grok-req-id',
  'x-grok-turn-idx',
  'x-grok-agent-id',
  'x-grok-model-override',
  'x-claude-code-session-id',
  'x-msh-device-id',
]);

const PREVIEW_SNAPSHOT = {
  installationId: '00000000-0000-4000-8000-000000000001',
  sharedSessionId: '00000000-0000-4000-8000-000000000002',
  threadId: '00000000-0000-4000-8000-000000000003',
  agentSessionId: '00000000-0000-4000-8000-000000000004',
  logicalId: '00000000-0000-7000-8000-000000000005',
  turnIndex: 1,
  windowId: '00000000-0000-4000-8000-000000000003:1',
  setTurnState: () => undefined,
};

const NPM_PLATFORM_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];

/**
 * Accept only a stable release of the expected package. For `@openai/codex` the per-platform
 * binaries must all be published at the same version, so a half-published release is skipped.
 */
export function parseNpmRelease(expectedName: string, body: unknown): string {
  if (typeof body !== 'object' || body === null) throw new Error('npm registry returned no document');
  const record = body as { name?: unknown; version?: unknown; optionalDependencies?: unknown };
  if (record.name !== expectedName) throw new Error(`npm registry returned ${String(record.name)} instead of ${expectedName}`);
  const version = record.version;
  if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,4}$/u.test(version)) {
    throw new Error(`npm latest version ${String(version)} is not a stable release`);
  }
  if (expectedName === '@openai/codex') {
    const deps = (record.optionalDependencies ?? {}) as Record<string, unknown>;
    for (const target of NPM_PLATFORM_TARGETS) {
      if (deps[`@openai/codex-${target}`] !== `npm:@openai/codex@${version}-${target}`) {
        throw new Error(`@openai/codex ${version} is missing the ${target} build`);
      }
    }
  }
  return version;
}

async function defaultCliProbe(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    return stdout;
  } catch {
    throw new Error(`${command} is not installed or did not answer --version`);
  }
}

function parseDocument(value: unknown): CatalogDocument {
  const empty: CatalogDocument = { version: 1, profiles: [], tracks: {} };
  if (typeof value !== 'object' || value === null) return empty;
  const raw = value as Partial<CatalogDocument>;
  const profiles: RequestIdentityProfile[] = [];
  for (const candidate of raw.profiles ?? []) {
    const parsed = requestIdentityProfileDraftSchema.safeParse(stripMeta(candidate));
    if (!parsed.success || typeof candidate.id !== 'string' || !candidate.id.startsWith('custom:')) continue;
    profiles.push({
      ...parsed.data,
      id: candidate.id,
      builtin: false,
      duplicated_from: candidate.duplicated_from,
      created_at: candidate.created_at,
      updated_at: candidate.updated_at,
    });
  }
  const tracks: CatalogDocument['tracks'] = {};
  for (const seed of REQUEST_IDENTITY_TRACK_SEEDS) {
    const stored = raw.tracks?.[seed.id];
    if (stored === undefined) continue;
    tracks[seed.id] = {
      current: stored.current,
      candidate: stored.candidate,
      history: Array.isArray(stored.history) ? stored.history : [],
      pinned: stored.pinned === true,
      lastCheck: stored.lastCheck,
    };
  }
  return { version: 1, profiles, tracks, manifestUrl: typeof raw.manifestUrl === 'string' ? raw.manifestUrl : undefined };
}

function stripMeta(profile: RequestIdentityProfile): unknown {
  const { id: _id, builtin: _builtin, duplicated_from: _from, created_at: _created, updated_at: _updated, ...draft } = profile;
  return draft;
}

function sameRevision(a: RequestIdentityTrackRevision, b: RequestIdentityTrackRevision): boolean {
  return a.version === b.version
    && (a.user_agent ?? '') === (b.user_agent ?? '')
    && JSON.stringify(a.headers ?? []) === JSON.stringify(b.headers ?? []);
}

function requireSeed(id: RequestIdentityTrackId) {
  const seed = REQUEST_IDENTITY_TRACK_SEEDS.find((candidate) => candidate.id === id);
  if (seed === undefined) throw notFound(id);
  return seed;
}

function invalid(message: string): Error2 {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_INVALID, message);
}

function notFound(id: string): Error2 {
  return new Error2(RequestIdentityErrors.codes.REQUEST_IDENTITY_NOT_FOUND, `request identity ${id} does not exist`);
}

registerScopedService(
  LifecycleScope.App,
  IRequestIdentityCatalog,
  RequestIdentityCatalog,
  ScopeActivation.OnScopeCreated,
  'requestIdentity',
);
