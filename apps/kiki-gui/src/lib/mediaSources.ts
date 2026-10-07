/**
 * Media sources — the GUI half of the single media plugin.
 *
 * One row per *source*, not per package. A reader thinks "I want to make an
 * image with OpenAI"; behind that is one package carrying many vendors, each
 * with its own settings, secrets, on/off switch and place in the per-modality
 * defaults. This module keeps those facts in ONE row so the list can hold a
 * thousand sources without a thousand cards, and projects them into the one
 * status a reader can act on.
 *
 * Every field a row carries is one the host already reported in
 * `managedSources()` — including each source's own settings schema, stored
 * values, which secrets are stored and which required settings are missing.
 * Nothing here is a join and nothing is inferred from a manifest: one call
 * answers for the whole list, so no row is ever "not checked" and no row
 * costs a request of its own.
 *
 * What the states are allowed to claim:
 *
 *  - `ready` is the host's own "no required setting is missing", not an
 *    inference from a form that happens to look filled in. A secret never
 *    comes back in `values`, so a stored key reads as absent; only the host
 *    knows whether a borrowed connection covers it.
 *  - `off` is this source switched off and `removed` is this source taken out
 *    of use while its configuration, jobs and handles are kept. Both are the
 *    reader's own choices, not faults, and neither is drawn as one.
 *  - `blocked` means a job for this source cannot proceed — the SDK's
 *    `blocked_reason` `needs_provider`. That is not the reader's fault.
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
  MediaManagedSource,
  MediaProviderDefinition,
  MediaScriptSourceInput,
  MediaSource,
  MediaVoicePage,
} from '@kiki/protocol';
import type { I18nKey } from '@kiki/session-core/i18n';

import type { KikiClient } from './client';

export type {
  MediaCapabilities,
  MediaCancelOutcome,
  MediaCatalog,
  MediaJob,
  MediaKind,
  MediaManagedSource,
  MediaProviderDefinition,
  MediaScriptSourceInput,
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
 * One row of the list: a *source* the tools can call, projected from the one
 * host answer `managedSources()` already gave for the whole list. The reader
 * sees "this is OpenAI images, from the Media package, it still needs a key,
 * and it is the default for images" as one fact rather than reconciling
 * several lists — which is the whole point of a list that has to survive a
 * thousand sources.
 *
 * A read model, not a wire type: every field is a fact the host already owns,
 * named so the list can be one array instead of a join performed in the view.
 * `source` below is the DTO itself, kept whole so a write carries the same
 * identity the read did.
 */
export interface MediaSourceEntry {
  /**
   * The raw provider id the tools address, and the id every write uses. The
   * host also answers a source group by any of its adapter ids, so a row is
   * keyed by its own `provider` and never by `pluginId`: one package
   * configuring the whole bundle is exactly what must not happen here.
   */
  readonly provider: string;
  /** The source's own id inside its package — the stable brand key. */
  readonly sourceId: string;
  /** The one package it came from. Never used to address a write. */
  readonly pluginId: string;
  /** The source's own brand label, as the package declares it. */
  readonly displayName: string;
  /** A reader's own script, which brings its own command and credentials. */
  readonly custom: boolean;
  readonly enabled: boolean;
  /** Kept, with its configuration and history, but out of use. */
  readonly removed: boolean;
  /** Every adapter this source answers to; the row draws all of their kinds. */
  readonly definitions: readonly MediaProviderDefinition[];
  /** The modalities the tools can reach through this source. */
  readonly kinds: readonly MediaKind[];
  /** The package's own health, from the plugin surface. */
  readonly broken: boolean;
  /** One diagnostic the reader should see, when the host has one. */
  readonly problem?: string;
  /** The settings form this source declares; absent when it declares none. */
  readonly settings?: MediaSourceSettings;
  /** Source id the reader chose for this modality, when this is that one. */
  readonly defaultFor?: readonly MediaKind[];
  /** The whole host answer, so a write is the same object the read returned. */
  readonly source: MediaManagedSource;
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
  readonly schema: { readonly type?: 'object'; readonly properties: Readonly<Record<string, MediaSettingProperty>>; readonly required?: readonly string[] };
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
 *  - `managedSources()` is the **one read that answers for the whole list** —
 *    every source in every package, with the settings form it declares, the
 *    values stored against it, which secrets are stored, and which required
 *    settings are missing right now. It is what makes a thousand rows cost
 *    one call, and it is why this view never reads a package's settings for
 *    a row it is not opening.
 *  - `sourceSettings()` re-reads one source for a form that is about to be
 *    written, and `updateSource()` writes it. Both are addressed by the raw
 *    `provider` id from the read, never by `pluginId` — one package holds
 *    many sources and a package-level write would move all of them.
 *  - `addScriptSource()` adds one reader's own script source, which the same
 *    package carries. The script is data this GUI types, not a package it
 *    installs, so nothing here discovers or fetches a vendor.
 *  - `sources()` is the **subscription roster** — where new packages are
 *    discovered from (`{id, url, enabled}`), not the list of sources. It is
 *    a management fact about where to look, and it is persisted by the host.
 *    This GUI never keeps its own copy.
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
  managed: ['media-managed-sources'] as const,
  /** One source's live form state, keyed by its own provider id. */
  source: (provider: string) => ['media-managed-source', provider] as const,
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

/**
 * Every source the host knows about, in one call.
 *
 * This is the list the page draws, so a thousand rows cost exactly one
 * request — and each row already carries the configuration verdict that a
 * per-row settings read would have cost another thousand. A write replaces
 * one entry in this cache from the source the host returned, so the list
 * never refetches to learn whether a save landed.
 */
export function useMediaManagedSources(client: KikiClient, enabled = true) {
  const api = mediaApi(client);
  return useQuery({
    queryKey: mediaKeys.managed,
    queryFn: () => api!.managedSources(),
    enabled: enabled && api !== undefined,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * One source, re-read for a form that is about to be written.
 *
 * The form opens against the row the list already holds and then reads this
 * once, so a source that was changed in another window is not written over
 * from a stale draft. The host answers by the same provider id the row carries.
 */
export function useMediaSourceSettings(client: KikiClient, provider: string | undefined) {
  const api = mediaApi(client);
  return useQuery({
    queryKey: mediaKeys.source(provider ?? ''),
    queryFn: () => api!.sourceSettings({ provider: provider! }),
    enabled: provider !== undefined && api !== undefined,
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * How one source write ended, reported to the view rather than rendered by it.
 *
 * `source` is the host's own answer to the write: the source as the host now
 * holds it, not the values the caller sent. A caller that trusts this instead
 * of its own request is trusting the host, which is the whole point of asking
 * the host at all.
 */
export type MediaSourceWriteResult =
  | { readonly ok: true; readonly source: MediaManagedSource }
  | { readonly ok: false; readonly error: unknown };

/** The four media-source writes, in the shape a caller must accept. */
export type MediaSourceUpdateInput = {
  readonly provider: string;
  readonly values?: Record<string, string | number | boolean | null>;
  readonly enabled?: boolean;
  readonly removed?: boolean;
};

/**
 * Write one source: its values, its on/off switch, or its removal.
 *
 * Every call is addressed by the raw `provider` id. `values` carries `null`
 * for a key the reader emptied or cleared, which is how a removal is
 * expressed; an untouched key is simply absent and the host keeps it.
 *
 * `update` is AWAITABLE and REJECTS when the host refuses. That is not a
 * stylistic choice: the form's decision to clear a draft, to show "saved",
 * or to read the values back all depend on the write having actually
 * happened. A fire-and-forget call makes the form read the old values while
 * the write is still in flight, and makes a rejected write look exactly like
 * a successful one — because a plain GET afterwards still succeeds. The
 * pending flag and the last outcome stay here for the views that want to
 * render them; neither is what a caller awaits.
 */
export function useMediaSourceUpdate(client: KikiClient) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MediaSourceWriteResult | null>(null);

  const run = useCallback(async (input: MediaSourceUpdateInput): Promise<MediaSourceWriteResult> => {
    const api = mediaApi(client);
    if (api === undefined) {
      const failure: MediaSourceWriteResult = { ok: false, error: new Error('media domain unavailable') };
      setOutcome(failure);
      throw failure.error;
    }
    setPending(true);
    setOutcome(null);
    try {
      const settled = await api.updateSource(input);
      // Both the list row and the open form read the same host answer, so one
      // write updates both and neither refetches to find out what happened.
      queryClient.setQueryData<MediaManagedSource[]>(mediaKeys.managed, (current) =>
        current?.map((item) => (item.provider === settled.provider ? settled : item)));
      queryClient.setQueryData<MediaManagedSource>(mediaKeys.source(settled.provider), settled);
      const done: MediaSourceWriteResult = { ok: true, source: settled };
      setOutcome(done);
      return done;
    } catch (error) {
      setOutcome({ ok: false, error });
      // Re-thrown so a caller that awaits cannot mistake a refused write for a
      // quiet one. The caches above are deliberately left alone: they still
      // hold the last state the host confirmed.
      throw error;
    } finally {
      setPending(false);
    }
  }, [client, queryClient]);

  return { pending, outcome, update: run };
}

/**
 * Add one reader's own script source to the media package.
 *
 * Awaitable and rejecting, for the same reason `useMediaSourceUpdate` is: a
 * form that closes on a promise nobody awaited would close on a *refused*
 * write and take the reader's command line with it. The settled source is put
 * straight into the list cache, so a new script appears in the page the reader
 * is looking at without a refetch it would have to wait for. Nothing here
 * installs a vendor package: a script source is a command line and a protocol,
 * both of which the reader typed.
 */
export function useMediaScriptSourceAdd(client: KikiClient) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<MediaSourceWriteResult | null>(null);

  const run = useCallback(async (input: MediaScriptSourceInput, onAdded?: (provider: string) => void): Promise<MediaSourceWriteResult> => {
    const api = mediaApi(client);
    if (api === undefined) {
      const failure: MediaSourceWriteResult = { ok: false, error: new Error('media domain unavailable') };
      setOutcome(failure);
      throw failure.error;
    }
    setPending(true);
    setOutcome(null);
    try {
      const settled = await api.addScriptSource(input);
      queryClient.setQueryData<MediaManagedSource[]>(mediaKeys.managed, (current) => {
        const rest = (current ?? []).filter((item) => item.provider !== settled.provider);
        return [...rest, settled];
      });
      const done: MediaSourceWriteResult = { ok: true, source: settled };
      setOutcome(done);
      onAdded?.(settled.provider);
      return done;
    } catch (error) {
      setOutcome({ ok: false, error });
      throw error;
    } finally {
      setPending(false);
    }
  }, [client, queryClient]);

  return { pending, outcome, add: run };
}

/**
 * The declared form, or an empty one.
 *
 * A source that declares no settings has no schema, and a package that
 * declares none answers with values and secrets only. Reading
 * `schema.schema.properties` off that answer is a crash, and a crash inside a
 * detail the reader just opened loses the whole page — so a form with nothing
 * to draw is an empty form.
 */
export function schemaOf(raw: unknown): MediaSettingSchema {
  const schema = (raw as { readonly schema?: { readonly properties?: unknown } } | undefined)?.schema;
  const properties = (schema?.properties ?? {}) as MediaSettingSchema['schema']['properties'];
  return { schema: { properties } };
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
 * Every arm here is one host answer the list already holds, which is the whole
 * difference from a list that read each package's settings to find out: with a
 * single `managedSources()` answer there is no "not checked" band to explain,
 * and no row can be filtered into "needs setup" on the strength of a form that
 * merely looks empty.
 *
 *  - `off` is the reader's own switch, and `removed` is the reader's own
 *    removal that kept its configuration and history. Neither is a fault, so
 *    neither borrows the danger tone a broken row uses.
 *  - `broken` is the package behind the source failing to load — the one
 *    state this list cannot fix from the row.
 *  - `blocked` means a job for this source cannot proceed. Not the reader's
 *    fault either, and kept separate from `broken` for that reason.
 */
export type MediaSourceStatus = 'broken' | 'needs-config' | 'blocked' | 'default' | 'removed' | 'off' | 'ready';

export function mediaSourceStatus(entry: MediaSourceEntry, blocked = false): MediaSourceStatus {
  if (entry.broken) return 'broken';
  if (blocked) return 'blocked';
  // Removed beats disabled in the copy because it is the stronger, reversible
  // choice: the configuration, the jobs and the handles are all still there.
  if (entry.removed) return 'removed';
  if (!entry.enabled) return 'off';
  // The default is a fact the reader saved, and it is a different fact from
  // whether the source is configured. So the badge stays whatever the reader
  // chose, and is not a gate on choosing one.
  if ((entry.defaultFor?.length ?? 0) > 0) return 'default';
  return needsConfig(entry) === true ? 'needs-config' : 'ready';
}

/**
 * The host's own "a required setting is missing" answer, and only that.
 *
 * The form's `required` list is NOT a substitute, and the reasons are the same
 * three as before: a field can be declared required and still be satisfied by
 * a value the host holds elsewhere; a secret never comes back in `values` at
 * all, so a stored key reads as absent; and a source may borrow an existing
 * connection or manage its own credentials entirely, in which case an empty key
 * is the correct state rather than a fault.
 *
 * `undefined` is therefore only reachable for a source that declares no
 * settings at all — where "there is nothing to configure" *is* the answer, and
 * the row reports readiness without having inferred anything.
 */
export function needsConfig(entry: MediaSourceEntry): boolean | undefined {
  const missing = entry.settings?.missing;
  if (missing === undefined) return undefined;
  return missing.length > 0;
}

export function statusKey(status: MediaSourceStatus): I18nKey {
  return `cap.media.status.${status}` as I18nKey;
}

// ---------------------------------------------------------------------------
// Search and filter, over a thousand rows
// ---------------------------------------------------------------------------

export type MediaSourceFilter = 'all' | MediaKind | 'ready' | 'needs-config' | 'blocked' | 'error' | 'removed' | 'off';

export interface MediaSourceFilterBand {
  readonly id: MediaSourceFilter;
  readonly count: number;
}

const FILTER_ORDER: readonly MediaSourceFilter[] = ['all', 'image', 'video', 'tts', 'ready', 'needs-config', 'off', 'removed', 'blocked', 'error'];

/** Whether a source belongs in a band. A multi-kind source counts in each. */
export function matchesFilter(entry: MediaSourceEntry, filter: MediaSourceFilter, blocked = false): boolean {
  if (filter === 'all') return true;
  const status = mediaSourceStatus(entry, blocked);
  if (filter === 'ready') return status === 'ready' || status === 'default';
  if (filter === 'needs-config') return status === 'needs-config';
  if (filter === 'off') return status === 'off';
  if (filter === 'removed') return status === 'removed';
  if (filter === 'blocked') return status === 'blocked';
  if (filter === 'error') return status === 'broken';
  return entry.kinds.includes(filter);
}

/**
 * Count per band over the whole list, so a filter says how many are behind it
 * before the reader commits. One pass over one array the host already sent; at a
 * thousand rows that is arithmetic, not requests.
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
 * Free text over the fields a reader actually knows a source by: its brand
 * label, its own id, the provider id the tools use, and what it makes. Not its
 * settings — a thousand API keys is not a search index, and a filter box is
 * the last place a secret fragment should appear.
 */
export function mediaSourceMatches(entry: MediaSourceEntry, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return [entry.displayName, entry.provider, entry.sourceId, entry.pluginId, ...entry.kinds]
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
    // Sources the reader took out of use sink below the live ones rather than
    // leading the page: they are kept, not urgent, and a list where every
    // removal outranks every working source cannot be scanned.
    if (status === 'off' || status === 'removed') return 5;
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
 * The source the tools use for a modality when the request names none. It
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
 * One row per source, built from the one host answer the list already has.
 *
 * `managedSources()` is the whole join: it carries the package each source came
 * from, whether that package is installed and healthy, the settings form the
 * source declares, its stored values, and which required settings are missing.
 * `defaults` is the media package's own default setting, so a row knows
 * whether it is the reader's chosen source for a modality without this view
 * owning a separate fact.
 *
 * The composition is deliberately thin. Every field is copied or derived, and
 * nothing is fetched: a thousand rows cost the one call the page already made,
 * and a source that the host has not configured is still drawn as ready rather
 * than as unknown, because that is what the host said.
 */
export function composeMediaSources(
  managed: readonly MediaManagedSource[],
  healthOf: (pluginId: string) => { readonly enabled: boolean; readonly broken: boolean; readonly problem?: string } | undefined,
  defaults: Readonly<Record<MediaKind, string | undefined>>,
): readonly MediaSourceEntry[] {
  return managed.map((source) => {
    const health = healthOf(source.pluginId);
    const kinds = [...new Set(source.definitions.flatMap((definition) => definition.kinds))];
    return {
      provider: source.provider,
      sourceId: source.sourceId,
      pluginId: source.pluginId,
      displayName: source.label,
      custom: source.custom,
      enabled: source.enabled,
      removed: source.removed,
      definitions: source.definitions,
      kinds,
      // A source whose package never installed, failed to load, or is switched
      // off at the package level cannot generate — which is what the host
      // already folded into `enabled`, and is repeated here so a list that has
      // not seen the plugin list can still tell the reader.
      broken: health?.broken === true || health === undefined || !health.enabled,
      ...(health?.problem === undefined ? {} : { problem: health.problem }),
      settings: {
        schema: { schema: source.schema.schema },
        values: source.values,
        secretsConfigured: source.secretsConfigured,
        missing: source.missing,
      },
      defaultFor: (Object.keys(defaults) as MediaKind[]).filter((kind) => defaults[kind] === source.provider),
      source,
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

/**
 * Where the media package's settings live in the query cache — the ONE key.
 *
 * The list reads the three defaults out of this entry and the detail writes
 * them into it, so both halves of the page answer from the same place. It is
 * named here rather than spelled out at each use because a write that put its
 * result under a slightly different key would leave the list reading a stale
 * value forever, and nothing would say so: the default would simply stay with
 * the old source until a reload.
 */
export function mediaDefaultsKey(pluginId: string): readonly ['plugin-settings', string] {
  return ['plugin-settings', pluginId];
}

/**
 * Hand one modality's default to a source, and leave every other fact current.
 *
 * The write goes through the media package's own settings and comes back as the
 * host's own echo of them. That echo — not the patch this function built — is
 * what lands in the cache the list reads, because the echo is the only answer
 * here that includes the OTHER two modalities' pointers. Writing just the key
 * that moved would clear the other two, and the page would claim an image and
 * a video source had no default at all.
 *
 * Returns whether the host accepted the choice, so a caller can tell a saved
 * default from a refused one; the failure reason is in `error` for the same
 * turn. The failure path leaves the cache holding the last defaults the host
 * confirmed.
 */
export function useMediaDefaultUpdate(client: KikiClient) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<MediaKind | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = useCallback(async (kind: MediaKind, provider: string | undefined): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    setPending(kind);
    setError(null);
    try {
      const echoed = await client.setPluginSettings(MEDIA_DEFAULTS_PLUGIN_ID, defaultPatch(kind, provider));
      // The WHOLE response, not just its values. This cache key is shared with
      // PluginSettingsForm, which reads `schema` and `secretsConfigured` off
      // the same entry — storing only `.values` here would leave that form
      // with nothing to render the next time a default was moved. One key, one
      // shape, whichever page wrote it.
      queryClient.setQueryData(mediaDefaultsKey(MEDIA_DEFAULTS_PLUGIN_ID), echoed);
      return { ok: true };
    } catch (failure) {
      setError(failure);
      return { ok: false, error: failure };
    } finally {
      setPending(null);
    }
  }, [client, queryClient]);

  return { pending, error, update: run };
}

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
