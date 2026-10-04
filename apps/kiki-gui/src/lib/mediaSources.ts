/**
 * Media sources — the GUI half of the D12 unified media plugin.
 *
 * One object, not four lists. A reader thinks "I want to make an image with
 * X"; behind that is a discovered catalog source, an installed provider
 * package, that package's own settings and secrets, and a per-modality
 * default. This module keeps those four facts in ONE row so the list can hold
 * a hundred providers without a hundred cards, and projects the four into the
 * one status a reader can act on.
 *
 * The DTOs are the SDK's, re-exported by `@kiki/protocol`
 * (`packages/plugin-sdk/src/media.ts`); nothing here restates a wire shape.
 * `MediaSourceEntry` below is a *read model*, not a wire type: it is the
 * composition of two things the host already reports — the adapter as its
 * package declares it (`MediaProviderDefinition`) and the plugin's install /
 * settings state (`PluginSummary` / `PluginSettingsResponse`). The host
 * composes it; the GUI never re-derives it from a raw manifest.
 *
 * What the states are allowed to claim:
 *
 *  - `needs-config` means the host says a required setting is missing. When
 *    the host does not say, it falls back to the form's own `required` list
 *    against stored keys — a declared field, not a probe.
 *  - `broken` covers a package whose host failed to load *and* one the reader
 *    switched off: neither can generate. A *job* that failed is a different
 *    thing and never paints a row red.
 *  - `blocked` means a job for this provider cannot proceed — the SDK's
 *    `blocked_reason` `needs_provider`. The package is gone or disabled, and
 *    that is not the reader's fault.
 *  - Nothing here probes. A row's status is one host answer, already
 *    computed; the list never fires a per-row request to find out.
 */

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type {
  MediaCapabilities,
  MediaCancelOutcome,
  MediaCapabilityQuery,
  MediaCatalog,
  MediaJob,
  MediaKind,
  MediaProviderDefinition,
  MediaSource,
  MediaVoicePage,
  MediaVoiceQuery,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { KikiClient, PluginSummary } from './client';

export type {
  MediaCapabilities,
  MediaCancelOutcome,
  MediaCatalog,
  MediaJob,
  MediaKind,
  MediaProviderDefinition,
  MediaSource,
  MediaVoicePage,
};

/**
 * One produced file, as the SDK's artifact schema. Derived from `MediaJob`
 * rather than re-declared, so there is exactly one definition of what an
 * artifact is and it is the SDK's.
 */
export type MediaArtifact = MediaJob['artifacts'][number];

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

/**
 * One row of the list: a provider, composed from the adapter its package
 * declares (`providers()`) and that package's own install and settings state
 * (the plugin surface). The reader sees "this is MiniMax video, from this
 * package, and it still needs a key" as one fact rather than reconciling three
 * lists — which is the whole point of a list that has to survive a hundred
 * providers.
 *
 * A read model, not a wire type: every field is a fact the host already owns,
 * named so the list can be one array instead of a join performed in the view.
 */
export interface MediaSourceEntry {
  /** `<pluginId>/<adapterId>` — the provider id the tools use. */
  readonly provider: string;
  readonly pluginId: string;
  /** The adapter as its package declares it (id, kinds, label, resumeVersion). */
  readonly definition: MediaProviderDefinition;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  /** The package's own health, from the plugin surface. */
  readonly broken: boolean;
  /** One diagnostic the reader should see, when the host has one. */
  readonly problem?: string;
  /** The settings form the package declares; absent when it declares none. */
  readonly settings?: MediaSourceSettings;
  /** Provider id the reader chose for this modality, when this is that one. */
  readonly defaultFor?: readonly MediaKind[];
}

export interface MediaSourceSettings {
  readonly schema: MediaSettingSchema;
  readonly values: Readonly<Record<string, string | number | boolean>>;
  /** Which secret keys are stored. Their values are never read back. */
  readonly secretsConfigured: readonly string[];
  /** Keys the host reports as missing right now. */
  readonly missing?: readonly string[];
}

/** The same property subset the existing plugin settings form accepts. */
export interface MediaSettingProperty {
  readonly type: 'string' | 'boolean' | 'number';
  readonly title?: string;
  readonly description?: string;
  readonly secret?: boolean;
  readonly default?: string | number | boolean;
  /** A fixed choice the reader picks from, when the package declares one. */
  readonly enum?: readonly string[];
}

export interface MediaSettingSchema {
  readonly schema: { readonly properties: Readonly<Record<string, MediaSettingProperty>>; readonly required?: readonly string[] };
}

// ---------------------------------------------------------------------------
// The host seam
// ---------------------------------------------------------------------------

/**
 * The host seam, read straight off the landed klient facade
 * (`GlobalMediaFacade` / `AgentMediaFacade`). This file re-declares nothing:
 * the two interfaces below are the *narrow surface this GUI uses*, and every
 * member is a member the real facade already has.
 *
 * What the real facade gives us, and where each piece is drawn:
 *
 *  - `sources()` is the **subscription roster** — where new providers are
 *    discovered from (`{id, url, enabled}`), not the list of installed
 *    providers. It is a management fact about where to look, and it is
 *    persisted by the host. This GUI never keeps its own copy.
 *  - `providers()` is the **installed provider list** — one entry per
 *    `<pluginId>/<adapterId>` with the adapter as its package declared it.
 *  - A provider's *configuration* is not on this contract, and correctly so:
 *    it is that package's own settings, already readable and writable through
 *    the existing plugin settings REST. The GUI reuses that rather than
 *    inventing a second settings store.
 *  - `capabilities()` may answer either a page or the provider roster, which
 *    is how an unconfigured request says "here is who you could use" without
 *    failing. `isProviderRoster` is the discriminant.
 *  - `jobs()` is read-only. Stopping and resuming belong to the session and
 *    agent that own the job (`mediaJobSchema.owner_session_id` /
 *    `owner_agent_id`), so they go through `agent(id).media`, never a global
 *    shortcut that would act on another conversation's money silently.
 *
 * The whole surface may be `undefined` on a server that has not registered the
 * media domain. That reads as *unavailable*, which is the only honest answer
 * until it does — an empty list would claim the reader has no sources.
 */
export interface MediaJobActions {
  cancel(id: string): Promise<MediaJob>;
  resume(id: string): Promise<MediaJob>;
}

/**
 * How one stop or resume ended, reported to the view rather than rendered by
 * it. The view owns the wording; this layer owns the call and the cache write.
 */
export type MediaJobActionResult =
  | { readonly ok: true; readonly kind: 'resume' | 'stop'; readonly job_id: string; readonly job: MediaJob }
  | { readonly ok: false; readonly kind: 'resume' | 'stop'; readonly job_id: string; readonly error: unknown };

/**
 * The result of the last action, or `null` when none has been taken.
 *
 * The absence lives on the hook's state, not inside the union: a consumer that
 * has a result should narrow `ok` and nothing else, and a `| null` member makes
 * every one of them null-check first even when they already know an action ran.
 */
export type MediaJobActionOutcome = MediaJobActionResult | null;

/**
 * Whether an outcome is about this job.
 *
 * One action hook serves a list of a dozen rows, and an outcome is about the
 * one the reader pressed a button on. Without this test the success line
 * renders under every row, which reads as a claim about eleven jobs nobody
 * touched — the failure mode this predicate exists to make impossible.
 */
export function outcomeIsFor(outcome: MediaJobActionOutcome, jobId: string): boolean {
  return outcome !== null && outcome.job_id === jobId;
}

/** The subscribed discovery sources, as the host stores them. */
export type MediaSourceSubscription = MediaSource;

export type MediaJobsInput = { readonly session_id?: string; readonly limit?: number; readonly offset?: number };

/** What `providers()` answers: one entry per installed adapter. */
export type MediaDomainSurface = NonNullable<KikiClient['klient']['global']['media']>;

export type MediaProvidersResponse = Awaited<ReturnType<MediaDomainSurface['providers']>>;

export type MediaCapabilityQueryInput = MediaCapabilityQuery;

/**
 * `capabilities()` answers a capability page *or* `{ providers }` — the
 * roster, which is how an unknown or unconfigured provider says "here is who
 * you could use" instead of failing.
 *
 * Both arms of the contract union are passthrough objects, so the guard reads
 * the one field that only a page has. It is a discriminant, not a validator:
 * the response was already parsed by the contract on the way in, and this file
 * deliberately does not re-check a shape it does not own.
 */
export function isProviderRoster(
  value: MediaCapabilities | MediaProvidersResponse,
): value is MediaProvidersResponse {
  return !Array.isArray((value as { readonly models?: unknown }).models);
}

/**
 * The media domain of one connected client, or `undefined` when the server has
 * not registered it.
 *
 * This is the klient facade's own type, aliased — not a second declaration of
 * the same surface. When 506 changes a signature, this file changes with it
 * instead of drifting into a parallel contract that typechecks against nothing.
 */
export function mediaApi(client: KikiClient): MediaDomainSurface | undefined {
  return client.klient.global.media;
}

/**
 * The actions for one job, through the agent that owns it, or `undefined`
 * when that owner cannot act. A view that cannot stop or resume a job hides
 * the control rather than offering one that silently does nothing.
 */
export function mediaJobActions(client: KikiClient, job: MediaJob): MediaJobActions | undefined {
  // Scoping is the whole point: cancel and resume are only legal through the
  // session and agent that own the job, so the view asks that owner rather
  // than calling a global endpoint with someone else's id. The chain is the
  // klient's own typed one, so a renamed method breaks this file at compile
  // time instead of at the call.
  return client.klient.session(job.owner_session_id).agent(job.owner_agent_id).media;
}

export const mediaKeys = {
  subscriptions: ['media-subscriptions'] as const,
  providers: ['media-providers'] as const,
  settings: (pluginId: string) => ['media-source-settings', pluginId] as const,
  jobs: (sessionId: string, limit: number) => ['media-jobs', sessionId, limit] as const,
  capabilities: (provider: string, model: string, kind: string) => ['media-capabilities', provider, model, kind] as const,
  voices: (provider: string, model: string, language: string) => ['media-voices', provider, model, language] as const,
  catalog: (id: string) => ['media-catalog', id] as const,
};

export function useMediaSubscriptions(client: KikiClient, enabled = true) {
  const api = mediaApi(client);
  return useQuery({
    queryKey: mediaKeys.subscriptions,
    queryFn: () => api!.sources(),
    enabled: enabled && api !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

export function useMediaProviders(client: KikiClient, enabled = true) {
  const api = mediaApi(client);
  return useQuery({
    queryKey: mediaKeys.providers,
    queryFn: () => api!.providers(),
    enabled: enabled && api !== undefined,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * One package's settings, read through the existing plugin settings REST. The
 * same values, the same secret semantics and the same save path the plugin
 * detail form already uses — a provider's key is a plugin's key.
 */
export function useMediaSourceSettings(client: KikiClient, pluginId: string | undefined) {
  return useQuery({
    queryKey: mediaKeys.settings(pluginId ?? ''),
    queryFn: async (): Promise<MediaSourceSettings> => {
      const view = await client.getPluginSettings(pluginId!);
      return {
        schema: schemaOf(view.schema),
        values: view.values,
        secretsConfigured: view.secretsConfigured,
      };
    },
    enabled: pluginId !== undefined,
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * The declared form, or an empty one.
 *
 * A package that declares no settings has no schema, and the settings route
 * answers with values and secrets only. Reading `schema.schema.properties` off
 * that answer is a crash, and a crash inside a detail the reader just opened
 * loses the whole page — so a form with nothing to draw is an empty form.
 */
export function schemaOf(raw: unknown): MediaSettingSchema {
  const schema = (raw as { readonly schema?: { readonly properties?: unknown } } | undefined)?.schema;
  const properties = (schema?.properties ?? {}) as MediaSettingSchema['schema']['properties'];
  return { schema: { properties } };
}

/**
 * Whether media *generation* is enabled on this server.
 *
 * Read from `/meta` the same way the import-history and native-SSH flags are
 * read, so there is one place a flag is looked up rather than one per feature.
 *
 * What this flag does and does not mean, read off the service rather than
 * assumed: `providers()`, `sources()`, `jobs()` and the rest of the management
 * surface are registered unconditionally, so they keep answering while this is
 * off. Only `start()` refuses. So this flag is never a reason to hide the list,
 * a source, a past job or a form — it is only the reason a *new* generation
 * cannot be started, which is what the view says when it is off.
 *
 * `undefined` means not known yet, which is not the same as off.
 */
export const MEDIA_GENERATION_FLAG = 'media_generation';

export function useMediaGenerationEnabled(client: KikiClient): { enabled: boolean | undefined; loading: boolean } {
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => client.meta(), staleTime: 15_000 });
  return {
    enabled: meta.data === undefined ? undefined : meta.data.experimental_flags?.[MEDIA_GENERATION_FLAG] === true,
    loading: meta.isLoading,
  };
}

export function useMediaJobs(client: KikiClient, sessionId: string, limit = 20) {
  const api = mediaApi(client);
  return useQuery({
    queryKey: mediaKeys.jobs(sessionId, limit),
    queryFn: () => api!.jobs({ session_id: sessionId, limit }),
    enabled: api !== undefined,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Stop or resume one job, through the agent that owns it.
 *
 * Both are mutations of the job the reader is looking at, so the settled job
 * the host returns replaces the stale one in the cache rather than triggering a
 * list refetch: the answer to "did stopping work" is the stopped job, and
 * refetching a list to learn that is both slower and less precise. Anything
 * else in the session's job list is unchanged by this, which is why the cache
 * update is keyed to the one entry.
 *
 * A job with no owning session, or one this build cannot reach, yields `null`
 * rather than a control wired to nothing.
 */
export function useMediaJobAction(client: KikiClient, sessionId: string, limit = 20) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<{ readonly jobId: string; readonly kind: 'resume' | 'stop' } | null>(null);
  const [outcome, setOutcome] = useState<MediaJobActionResult | null>(null);

  const run = useCallback(
    async (job: MediaJob, kind: 'resume' | 'stop') => {
      const actions = mediaJobActions(client, job);
      if (actions === undefined) {
        setOutcome({ ok: false, kind, job_id: job.job_id, error: undefined });
        return;
      }
      setPending({ jobId: job.job_id, kind });
      setOutcome(null);
      try {
        const settled = kind === 'resume' ? await actions.resume(job.job_id) : await actions.cancel(job.job_id);
        // The answer to "did it work" is the settled job itself, so it replaces
        // the stale row in place. Nothing else in the session's list changed,
        // which is why this is a keyed cache write and not a refetch.
        queryClient.setQueryData<MediaJob[]>(mediaKeys.jobs(sessionId, limit), (current) =>
          current?.map((row) => (row.job_id === settled.job_id ? settled : row)),
        );
        setOutcome({ ok: true, kind, job_id: job.job_id, job: settled });
      } catch (error) {
        setOutcome({ ok: false, kind, job_id: job.job_id, error });
      } finally {
        setPending(null);
      }
    },
    [client, limit, queryClient, sessionId],
  );

  return {
    pending,
    outcome,
    resume: (job: MediaJob) => { void run(job, 'resume'); },
    stop: (job: MediaJob) => { void run(job, 'stop'); },
  };
}

// ---------------------------------------------------------------------------
// Status: the one fact a row can act on
// ---------------------------------------------------------------------------

/**
 * What a row can honestly say about itself.
 *
 * `ready` and `needs-config` are only ever reached from a settings read the
 * view actually has. The list deliberately does not make one: reading every
 * package's settings is a request per row, and a hundred rows would be a
 * hundred requests to learn something the detail page answers in one. So a row
 * whose configuration has not been read is `unchecked`, which is a real answer
 * and not a euphemism for "ready" — a reader who filters to "needs setup" must
 * never be shown a row that was merely never checked.
 *
 * `broken` and `blocked` are install-time facts the host reports without any
 * per-row read, so they are always available.
 */
export type MediaSourceStatus = 'broken' | 'needs-config' | 'blocked' | 'default' | 'unchecked' | 'ready';

export function mediaSourceStatus(entry: MediaSourceEntry, blocked = false): MediaSourceStatus {
  if (entry.broken || !entry.enabled) return 'broken';
  if (blocked) return 'blocked';
  // The default is a fact the reader saved, and it is a different fact from
  // whether the source is configured. So the badge stays whatever the reader
  // chose — "unchecked" is an admission about what is not known, and it is not
  // a gate on choosing a default or a reason to silently drop the one they have.
  if ((entry.defaultFor?.length ?? 0) > 0) return 'default';
  const config = configVerdict(entry);
  if (config === undefined) return 'unchecked';
  if (config === false) return 'needs-config';
  return 'ready';
}

/**
 * The host's own "a required setting is missing" answer, and only that.
 *
 * The form's `required` list is NOT a substitute. Three reasons, each of which
 * has been true of a real provider here: a field can be declared required and
 * still be satisfied by a value the host holds elsewhere; a secret never comes
 * back in `values` at all, so a stored key reads as absent; and a provider
 * may borrow an existing connection or manage its own credentials entirely, in
 * which case an empty key is the correct state rather than a fault.
 *
 * So without a host answer this is `undefined` — not checked — and the row says
 * so.
 */
export function needsConfig(entry: MediaSourceEntry): boolean | undefined {
  const missing = entry.settings?.missing;
  if (missing === undefined) return undefined;
  return missing.length > 0;
}

function configVerdict(entry: MediaSourceEntry): boolean | undefined {
  const missing = needsConfig(entry);
  if (missing === undefined) return undefined;
  return !missing;
}

export function statusKey(status: MediaSourceStatus): I18nKey {
  return `cap.media.status.${status}` as I18nKey;
}

// ---------------------------------------------------------------------------
// Search and filter, over a hundred rows
// ---------------------------------------------------------------------------

export type MediaSourceFilter = 'all' | MediaKind | 'ready' | 'needs-config' | 'blocked' | 'error' | 'unchecked';

export interface MediaSourceFilterBand {
  readonly id: MediaSourceFilter;
  readonly count: number;
}

const FILTER_ORDER: readonly MediaSourceFilter[] = ['all', 'image', 'video', 'tts', 'ready', 'needs-config', 'unchecked', 'blocked', 'error'];

/** Whether a source belongs in a band. A multi-kind source counts in each. */
export function matchesFilter(entry: MediaSourceEntry, filter: MediaSourceFilter, blocked = false): boolean {
  if (filter === 'all') return true;
  const status = mediaSourceStatus(entry, blocked);
  if (filter === 'ready') return status === 'ready' || status === 'default';
  if (filter === 'needs-config') return status === 'needs-config';
  if (filter === 'unchecked') return status === 'unchecked';
  if (filter === 'blocked') return status === 'blocked';
  if (filter === 'error') return status === 'broken';
  return entry.definition.kinds.includes(filter);
}

/**
 * Count per band over the whole list, so a filter says how many are behind it
 * before the reader commits. One pass; a hundred rows is nothing, and a
 * request per row would not be.
 */
export function filterBands(sources: readonly MediaSourceEntry[], blocked: ReadonlySet<string> = new Set()): readonly MediaSourceFilterBand[] {
  const counts = new Map<MediaSourceFilter, number>(FILTER_ORDER.map((id) => [id, 0]));
  for (const entry of sources) {
    const isBlocked = blocked.has(entry.provider);
    for (const id of FILTER_ORDER) {
      if (matchesFilter(entry, id, isBlocked)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return FILTER_ORDER
    .filter((id) => id === 'all' || (counts.get(id) ?? 0) > 0)
    .map((id) => ({ id, count: counts.get(id) ?? 0 }));
}

/**
 * Free text over the fields a reader actually knows a provider by: its label,
 * its id, the package it came from, and what it makes. Not its settings — a
 * hundred API keys is not a search index.
 */
export function mediaSourceMatches(entry: MediaSourceEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [entry.displayName, entry.provider, entry.pluginId, entry.definition.label, ...entry.definition.kinds]
    .some((field) => field.toLowerCase().includes(query));
}

/**
 * The visible list: search, then the band, then a stable order — anything
 * needing action first (broken, blocked, unconfigured), then the reader's own
 * default, then the rest by name. A search never reshuffles the page under
 * the reader.
 */
export function visibleMediaSources(
  sources: readonly MediaSourceEntry[],
  query: string,
  filter: MediaSourceFilter,
  blocked: ReadonlySet<string> = new Set(),
): readonly MediaSourceEntry[] {
  const rank = (entry: MediaSourceEntry): number => {
    const status = mediaSourceStatus(entry, blocked.has(entry.provider));
    if (status === 'broken') return 0;
    if (status === 'blocked') return 1;
    if (status === 'needs-config') return 2;
    if (status === 'default') return 3;
    return 4;
  };
  return sources
    .filter((entry) => mediaSourceMatches(entry, query) && matchesFilter(entry, filter, blocked.has(entry.provider)))
    .toSorted((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName));
}

// ---------------------------------------------------------------------------
// Per-modality defaults
// ---------------------------------------------------------------------------

/**
 * The provider the tools use for a modality when the request names none. It
 * is the one the reader chose; a second "ready" source is never silently
 * promoted to a paid one.
 */
export function defaultProviderFor(sources: readonly MediaSourceEntry[], kind: MediaKind): string | undefined {
  return currentDefault(sources, kind);
}

export function defaultKinds(entry: MediaSourceEntry): readonly MediaKind[] {
  return entry.defaultFor ?? [];
}

/**
 * One row per provider, built from the two lists the host already has.
 *
 * `providers()` says which adapters exist; the plugin list says whether the
 * package they came from is installed, on, and healthy, and what it is called.
 * Joining them here — once, in memory, over an array the host already sent —
 * is what lets the list be a single object per provider instead of four
 * parallel collections the reader has to reconcile.
 *
 * `defaults` is the entry package's own default setting, so a row knows
 * whether it is the reader's chosen provider for a modality without this view
 * owning a separate fact. `settings` is passed in only for a provider whose
 * package is actually open: a list of a hundred rows must not read a hundred
 * settings documents to draw a hundred one-line rows.
 */
export function composeMediaSources(
  providers: MediaProvidersResponse,
  plugins: readonly PluginSummary[],
  defaults: Readonly<Record<MediaKind, string | undefined>>,
  settingsOf?: (pluginId: string) => MediaSourceSettings | undefined,
): readonly MediaSourceEntry[] {
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return providers.map(({ provider, definition }) => {
    const pluginId = provider.split('/')[0] ?? provider;
    const plugin = pluginById.get(pluginId);
    const settings = settingsOf?.(pluginId);
    return {
      provider,
      pluginId,
      definition,
      displayName: plugin?.displayName ?? definition.label,
      ...(plugin?.version === undefined ? {} : { version: plugin.version }),
      enabled: plugin?.enabled ?? true,
      // A provider whose package never installed is not "broken" in the sense
      // of a failed load; it simply has no package behind it, which is the
      // same thing to a reader trying to use it.
      broken: plugin === undefined || plugin.state === 'error' || plugin.hasErrors,
      ...(settings === undefined ? {} : { settings }),
      defaultFor: (Object.keys(defaults) as MediaKind[]).filter((kind) => defaults[kind] === provider),
    };
  });
}

/**
 * The current holder of a modality's default, from the host's own list.
 *
 * A generation that names no provider uses exactly this one. A second "ready"
 * source is never silently promoted to a paid one, and when nothing holds the
 * default the tools are the ones to report that, not this view inventing a
 * choice the reader did not make.
 */
export function currentDefault(
  sources: readonly MediaSourceEntry[],
  kind: MediaKind,
): string | undefined {
  return sources.find((entry) => entry.defaultFor?.includes(kind) === true)?.provider;
}

/**
 * Where the per-modality defaults live — confirmed against the landed entry
 * package.
 *
 * They are three non-secret scalars on the media entry plugin
 * (`kiki-media`): `defaultImageProvider`, `defaultVideoProvider`,
 * `defaultTtsProvider`. Ordinary plugin settings, read and written through
 * the same per-key route as everything else a plugin configures, with the same
 * echo — so there is no separate defaults store, and no local copy that could
 * disagree with what the host stored.
 *
 * Putting them on the entry package rather than on each provider is the point:
 * a default is a statement about the *choice* between providers, and a choice
 * cannot belong to one of the things being chosen. Each vendor's own key stays
 * on that vendor's own settings, untouched.
 *
 * The host reads them in this order: an explicit `provider` in the request
 * wins; otherwise a non-empty value here; otherwise, if exactly one installed
 * provider matches the modality, that one. With several candidates and no
 * default set, the tools ask rather than rotate to a paid service.
 */
export const MEDIA_DEFAULTS_PLUGIN_ID = 'kiki-media';

/** The one setting key that holds a modality's default provider id. */
export function defaultSettingKey(kind: MediaKind): string {
  return `default${kind[0]!.toUpperCase()}${kind.slice(1)}Provider`;
}

/** The three keys, in the order a reader meets them. */
export const MEDIA_DEFAULT_KEYS: readonly MediaKind[] = ['image', 'video', 'tts'];

/**
 * The patch that hands one modality's default to `provider`, or clears it.
 * Only the one key moves: the other two modalities and every vendor setting
 * are left exactly as they are.
 */
export function defaultPatch(
  kind: MediaKind,
  provider: string | undefined,
): { readonly [key: string]: string | null } {
  return { [defaultSettingKey(kind)]: provider ?? null };
}

/**
 * Read the defaults out of the entry package's settings, so the list and the
 * detail can never show two different answers to "which provider is the
 * default for images".
 */
export function defaultsFromSettings(
  values: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<MediaKind, string | undefined> {
  return {
    image: readDefault(values?.['defaultImageProvider']),
    video: readDefault(values?.['defaultVideoProvider']),
    tts: readDefault(values?.['defaultTtsProvider']),
  };
}

/** An empty setting is not a default: the host treats a blank as unset. */
function readDefault(value: string | number | boolean | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Read the defaults back off the providers the host listed, so the list and
 * the detail can never show two different answers for the same question. The
 * entry package is the one that carries the setting, so a provider is the
 * default for a modality exactly when the entry named it.
 */
export function defaultsOf(sources: readonly MediaSourceEntry[]): Record<string, readonly MediaKind[]> {
  const defaults: Record<string, readonly MediaKind[]> = {};
  for (const entry of sources) {
    const kinds = entry.defaultFor ?? [];
    if (kinds.length > 0) defaults[entry.provider] = kinds;
  }
  return defaults;
}

/**
 * Add or remove one subscribed discovery source in the next host state.
 *
 * The host owns the roster (it persists it), so this only *proposes* a list.
 * Removing a subscription removes the place new providers are discovered from
 * — it never touches an installed package, a stored key, or a produced file,
 * and the copy that says so is on the control itself rather than in a dialog
 * the reader has to guess at.
 */
export function withSubscription(
  sources: readonly MediaSource[],
  next: MediaSource,
  remove = false,
): readonly MediaSource[] {
  return remove
    ? sources.filter((item) => item.id !== next.id)
    : [...sources.filter((item) => item.id !== next.id), next];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** A job still doing work, locally or at the provider. */
export function isJobActive(job: MediaJob): boolean {
  return job.state === 'running' || job.state === 'pending';
}

/**
 * A job whose outcome is genuinely unknown: the submission may have been
 * accepted and charged. It is never drawn as a plain failure, and this GUI
 * never offers to "retry" it — a retry here would be a second bill. What it
 * offers is a lookup, and a resume only for a job that has a remote handle.
 */
export function isJobUnknown(job: MediaJob): boolean {
  return job.state === 'unknown' || job.error?.submission === 'unknown';
}

/** Where the reader can ask the host to keep fetching. Never a resubmit. */
export function canResume(job: MediaJob): boolean {
  if (!job.can_resume) return false;
  return job.state === 'partial' || job.state === 'stopped' || job.state === 'pending' || job.state === 'unknown';
}

/** The artifacts a reader can actually open: originals, never a preview. */
export function originalArtifacts(job: MediaJob): readonly MediaArtifact[] {
  return job.artifacts.filter((artifact) => artifact.role === 'original');
}

export function jobStateKey(state: MediaJob['state']): I18nKey {
  return `cap.media.job.state.${state}` as I18nKey;
}

export function jobPhaseKey(phase: MediaJob['phase']): I18nKey {
  return `cap.media.job.phase.${phase}` as I18nKey;
}

/**
 * Whether stopping is worth offering. A settled job is not stoppable. A
 * provider with no cancel path still accepts a *local* stop — which stops the
 * waiting, not the remote generation, and the row says exactly that rather
 * than implying a refund.
 */
export function canStop(job: MediaJob): boolean {
  return isJobActive(job);
}

/**
 * What a stop actually did, in the words the SDK can support. `unsupported`
 * is a first-class answer, not a failure: the request went nowhere and the
 * provider may still be generating and charging.
 */
export function cancellationNote(cancellation: MediaCancelOutcome | undefined): 'remote-cancelled' | 'remote-requested' | 'local-only' | 'none' {
  if (cancellation === undefined) return 'none';
  if (cancellation.remote === 'cancelled') return 'remote-cancelled';
  if (cancellation.remote === 'requested') return 'remote-requested';
  return 'local-only';
}
