/**
 * Media sources — the Plugins tab's media sub-view.
 *
 * This is the mount point, and the only place the two halves meet: the list
 * (a thousand rows, searchable, one click to open) and the detail (one source's
 * settings, defaults, capabilities). Both read the same query, so configuring a
 * source and seeing its status change in the list are one fact rendered twice,
 * not two caches that can disagree.
 *
 * The data it composes, all of it the host's:
 *
 *  - `managedSources()` for every source in every package, already carrying
 *    each one's settings, stored values, stored secrets and missing-required
 *    list, so the whole page costs one call whatever the list's length.
 *  - the plugin list for whether the package behind a source is installed and
 *    healthy, and the media package's own settings for the per-modality
 *    defaults.
 *  - `sources()` for the subscription roster — where new packages are
 *    discovered from, which is a different question from which sources exist,
 *    and gets its own folded section rather than its own page.
 *
 * Two states are first-class and neither is an empty list: a server without
 * the media domain says so, and a server with a domain but nothing installed
 * says that instead. "You have no sources" and "this build cannot show
 * sources" are different facts, and only one of them is the reader's.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import { useInstalledPlugins } from '../capabilities/usePlugins';
import {
  MEDIA_DEFAULTS_PLUGIN_ID,
  composeMediaSources,
  mediaDefaultsKey,
  defaultsFromSettings,
  mediaApi,
  outcomeIsFor,
  useMediaJobAction,
  useMediaJobs,
  useMediaManagedSources,
  useMediaSubscriptions,
  type MediaJob,
  type MediaSourceEntry,
} from '../../lib/mediaSources';
import type { KikiClient } from '../../lib/client';
import { useConnection } from '../../state/connection';
import { InlineError, type Feedback } from '../controls';
import { Spinner } from '../icons';
import { SECONDARY_BUTTON } from '../ui';
import { CapabilitySection, EmptyNote, QUIET_BUTTON } from '../capabilities/primitives';
import { MediaJobView } from './MediaJobView';
import { MediaSourceDetail } from './MediaSourceDetail';
import { MediaSourceList } from './MediaSourceList';
import { MediaScriptSourceDialog } from './MediaScriptSourceDialog';
import { MediaSubscriptions } from './MediaSubscriptions';

/** How many recent jobs the list shows; enough to see the last one you made. */
const JOBS_LIMIT = 20;

/** The media package, which is also where the per-modality defaults live. */
const MEDIA_PACKAGE_ID = MEDIA_DEFAULTS_PLUGIN_ID;

/**
 * The media package's own settings, for the three per-modality defaults.
 *
 * One read of the package the whole page is about, through the same route
 * every other plugin setting uses — so the list and the detail answer "which
 * source is the default for images" from one place, and a write lands where the
 * host reads it. It is deliberately not per-source: one request for the list
 * beats one per modality, and a default is not any one source's property.
 *
 * The key is this module's own `mediaDefaultsKey` rather than a literal, and
 * the cached value is the WHOLE `PluginSettingsResponse` rather than a per-key
 * fragment: this is the same cache entry PluginSettingsForm uses, and it reads
 * `schema` and `secretsConfigured` off it, so storing only the three defaults
 * here would make that form lose its fields. The view below takes `.values`
 * out of the shared entry instead of reshaping what is stored.
 */
function useMediaPackageDefaults(client: KikiClient, enabled: boolean) {
  const query = useQuery({
    queryKey: mediaDefaultsKey(MEDIA_PACKAGE_ID),
    queryFn: () => client.getPluginSettings(MEDIA_PACKAGE_ID),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
  // The defaults are a view over the shared entry, not a store of their own.
  const values = query.data?.values;
  return { ...query, data: values === undefined ? undefined : { ...values } };
}

export function MediaSourcesView({
  sessionId,
  onBack,
  onOpenPlugin,
}: {
  /** Session whose jobs this view shows; no session, no job list. */
  readonly sessionId?: string;
  readonly onBack: () => void;
  /** Open a source's package on the ordinary plugin detail. */
  readonly onOpenPlugin?: (pluginId: string) => void;
}) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const api = mediaApi(client);
  const managed = useMediaManagedSources(client, api !== undefined);
  const subscriptions = useMediaSubscriptions(client, api !== undefined);
  const plugins = useInstalledPlugins();
  // The three defaults are the media package's own non-secret settings, so they
  // are read and written through the same per-key route as everything else that
  // package configures. They are deliberately not a source's fields: a default
  // is a statement about the choice *between* sources, and a choice cannot
  // belong to one of the things being chosen.
  const mediaSettings = useMediaPackageDefaults(client, api !== undefined);
  const jobs = useMediaJobs(client, sessionId ?? '', JOBS_LIMIT);
  const actions = useMediaJobAction(client, sessionId ?? '', JOBS_LIMIT);
  const [open, setOpen] = useState<string | null>(null);
  const [addingScript, setAddingScript] = useState(false);

  /**
   * The defaults come from the media package's own settings, so they live in
   * the same store as everything else a plugin configures. They are read from
   * the sources themselves (each row says which modalities it is the default
   * for) rather than from a separate document, which is why the list and the
   * detail can never disagree about who the default is.
   *
   * The package health lookup is the only join left: `managedSources()` says
   * which sources exist and how they are configured, and the plugin list says
   * whether the package that carries them is installed and loaded.
   */
  const entries = useMemo(() => {
    const summaries = plugins.data?.plugins ?? [];
    const healthOf = (pluginId: string) => {
      const plugin = summaries.find((summary) => summary.id === pluginId);
      if (plugin === undefined) return { enabled: false, broken: true };
      return {
        enabled: plugin.enabled,
        broken: plugin.state === 'error' || plugin.hasErrors,
        ...(plugin.state === 'error' ? { problem: t('cap.media.row.packageFailed', { plugin: plugin.displayName }) } : {}),
      };
    };
    return composeMediaSources(
      managed.data ?? [],
      healthOf,
      defaultsFromSettings(mediaSettings.data),
    );
  }, [managed.data, mediaSettings.data, plugins.data, t]);

  // A job that cannot proceed names the source that is missing. That is a fact
  // about the job, not a probe of the source, so it is derived from jobs the
  // view already has.
  const blockedProviders = useMemo(
    () => new Set((jobs.data ?? []).filter((job) => job.blocked_reason === 'needs_provider').map((job) => job.provider)),
    [jobs.data],
  );

  // The wording belongs here, next to the other copy decisions, and the hook
  // stays a plain call plus a cache write. The outcome carries the job it is
  // about: the list renders a dozen rows from one action hook, and "Stopped
  // waiting for this job" printed under all of them would be a lie about
  // eleven jobs the reader never touched.
  const jobFeedback = useMemo(() => (job: MediaJob): Feedback => {
    const outcome = actions.outcome;
    if (!outcomeIsFor(outcome, job.job_id) || outcome === null) return null;
    if (outcome.ok) return { tone: 'success', text: t(outcome.kind === 'resume' ? 'cap.media.job.resumed' : 'cap.media.job.stopped') };
    if (outcome.error === undefined) return { tone: 'error', text: t('cap.media.job.unowned') };
    return { tone: 'error', text: errorText(locale, outcome.error) };
  }, [actions.outcome, locale, t]);

  if (api === undefined) {
    return (
      <div className="min-w-0 space-y-4" data-media-sources-view="unavailable">
        <BackLink onBack={onBack} />
        <EmptyNote title={t('cap.media.unavailable')} body={t('cap.media.unavailableBody')} />
      </div>
    );
  }

  if (managed.isPending) {
    return (
      <div className="min-w-0 space-y-4" data-media-sources-view="loading">
        <BackLink onBack={onBack} />
        <p className="flex items-center gap-2 text-[13px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} />{t('cap.media.loading')}</p>
      </div>
    );
  }

  if (managed.isError) {
    return (
      <div className="min-w-0 space-y-4" data-media-sources-view="error">
        <BackLink onBack={onBack} />
        <div className="space-y-2">
          <InlineError error={managed.error} />
          <button type="button" className={SECONDARY_BUTTON} onClick={() => { void managed.refetch(); }} data-media-sources-retry>
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const selected: MediaSourceEntry | undefined = entries.find((entry) => entry.provider === open);

  if (selected !== undefined) {
    return (
      <div className="min-w-0" data-media-sources-view="detail">
        <MediaSourceDetail
          entry={selected}
          providers={entries}
          onBack={() => { setOpen(null); }}
          {...(onOpenPlugin === undefined ? {} : { onOpenPlugin })}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6" data-media-sources-view="list">
      <BackLink onBack={onBack} />

      <CapabilitySection
        id="media-sources"
        title={t('cap.media.title')}
        // Adding a script is a source, so the verb sits on the section it
        // adds to rather than in the folded discovery area below.
        aside={(
          <button
            type="button"
            className={`${SECONDARY_BUTTON} h-7`}
            data-media-add-script
            onClick={() => { setAddingScript(true); }}
          >
            {t('cap.media.addScript')}
          </button>
        )}
      >
        <MediaSourceList
          sources={entries}
          blockedProviders={blockedProviders}
          selected={open ?? undefined}
          onOpen={setOpen}
        />
      </CapabilitySection>

      {addingScript ? (
        <MediaScriptSourceDialog
          onClose={() => { setAddingScript(false); }}
          onAdded={(provider) => { setAddingScript(false); setOpen(provider); }}
        />
      ) : null}

      {/* Where new packages are discovered from. Folded, because it is a
          place to look occasionally, not the thing a reader came to do. */}
      <MediaSubscriptions
        sources={subscriptions.data ?? []}
        loading={subscriptions.isPending}
        onChange={async (next) => {
          await api.setSources({ sources: [...next] });
          await subscriptions.refetch();
        }}
      />

      {/* The reader's recent jobs for this session. Read-only on purpose: a
          job's stop and resume belong to the session and agent that own it,
          and this page has no business spending another conversation's money.
          The transcript's own task row is where those actions live. */}
      {sessionId !== undefined ? (
        <CapabilitySection id="media-jobs" title={t('cap.media.jobs')}>
          {jobs.isPending ? (
            <p className="mt-1 flex items-center gap-2 text-[12px] text-ink-faint" role="status"><Spinner label={t('cap.loading')} size={12} />{t('cap.loading')}</p>
          ) : jobs.isError ? (
            <InlineError error={jobs.error} />
          ) : (jobs.data ?? []).length === 0 ? (
            <p className="mt-1 text-[12px] text-ink-faint">{t('cap.media.jobsEmpty')}</p>
          ) : (
            <ul className="mt-1 space-y-3" data-media-jobs={jobs.data?.length}>
              {jobs.data?.map((job) => (
                <li key={job.job_id} className="min-w-0">
                  <MediaJobView
                    job={job}
                    sessionId={sessionId}
                    onResume={actions.resume}
                    onStop={actions.stop}
                    busy={actions.pending?.jobId === job.job_id ? actions.pending.kind : null}
                    feedback={jobFeedback(job)}
                  />
                </li>
              ))}
            </ul>
          )}
        </CapabilitySection>
      ) : null}
    </div>
  );
}

function BackLink({ onBack }: { readonly onBack: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" onClick={onBack} className={`${QUIET_BUTTON} -ml-1 px-1`} data-media-sources-back>
      <svg viewBox="0 0 16 16" aria-hidden focusable="false" className="h-3.5 w-3.5 fill-none stroke-current stroke-[1.25] stroke-linecap-round stroke-linejoin-round"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
      {t('cap.media.back')}
    </button>
  );
}
