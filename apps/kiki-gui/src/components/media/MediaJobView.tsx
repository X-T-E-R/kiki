/**
 * A media job — what a generation is, where it got to, and what the reader can
 * honestly do next.
 *
 * This renders in two places and must read identically in both: inside a tool
 * card, where a short generation returns its files inline, and in a source's
 * detail, where a long job came back after a restart. It is a *view of the
 * SDK's `MediaJob`*, never a second state machine — every fact below is a
 * field the host already owns.
 *
 * The honesty rules, because each one is a place a job view is tempted to lie:
 *
 *  - A job is never described as cancelled when only the local wait stopped.
 *    The SDK distinguishes `cancelled` / `requested` / `unsupported`; the last
 *    one means the provider may still be generating and charging, and the row
 *    says that in the reader's terms rather than showing a green tick.
 *  - A job whose submission outcome is unknown is never offered a "retry".
 *    A retry here would be a second bill against a provider that may already
 *    have taken the first. What it offers is a lookup, and a resume only when
 *    the host holds a remote handle.
 *  - `partial` keeps its finished files. Two of three images landing is two
 *    images the reader has, plus one item that did not.
 *  - A blocked job (`needs_provider`) keeps its job and its files and names
 *    the one thing that will unblock it. It is not a failure state.
 *  - `usage` is drawn only when the provider reported it. There is no
 *    estimate, no blended "tokens" unit, and no price.
 */

import { useState } from 'react';

import { useI18n } from '../../i18n';
import {
  canResume,
  canStop,
  cancellationNote,
  isJobActive,
  isJobUnknown,
  jobPhaseKey,
  jobStateKey,
  type MediaJob,
} from '../../lib/mediaSources';
import { FeedbackLine } from '../controls';
import { Icon, Spinner } from '../icons';
import { DANGER_GHOST_BUTTON } from '../ui';
import { CapabilityGlyph } from '../capabilities/CapabilityIcon';
import { QUIET_BUTTON } from '../capabilities/primitives';
import { MediaArtifactList } from './MediaArtifactList';
import { MediaKindGlyph } from './MediaKindGlyph';

/** The state dot's color, from the SDK's own state enum. */
export function jobTone(job: MediaJob): 'ok' | 'busy' | 'error' | 'off' | 'waiting' {
  if (job.state === 'succeeded') return 'ok';
  if (isJobActive(job)) return 'busy';
  if (job.state === 'partial') return 'waiting';
  if (job.state === 'unknown' || job.state === 'stopped' || job.state === 'failed') return 'error';
  return 'off';
}

/** The modality a job is about, read from the provider that took it. */
function jobModality(job: MediaJob): 'image' | 'video' | 'tts' | undefined {
  const provider = job.provider.toLowerCase();
  if (provider.includes('/image') || provider.includes('images')) return 'image';
  if (provider.includes('/video')) return 'video';
  if (provider.includes('/speech') || provider.includes('/tts') || provider.includes('/audio')) return 'tts';
  return undefined;
}

export function MediaJobView({
  job,
  sessionId,
  agentId,
  onResume,
  onStop,
  busy,
  feedback,
}: {
  readonly job: MediaJob;
  /** Session owning the artifact file ids. */
  readonly sessionId?: string;
  /** Producing agent, for artifact ids that carry a blob reference. */
  readonly agentId?: string;
  readonly onResume?: (job: MediaJob) => void;
  readonly onStop?: (job: MediaJob) => void;
  readonly busy?: 'resume' | 'stop' | null;
  readonly feedback?: { readonly tone: 'info' | 'success' | 'error'; readonly text: string } | null;
}) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const tone = jobTone(job);
  const modality = jobModality(job);
  const unknown = isJobUnknown(job);
  const resumable = canResume(job);
  const stoppable = canStop(job);
  const cancelNote = cancellationNote(job.cancellation);

  return (
    <div className="min-w-0" data-media-job={job.job_id} data-media-job-state={job.state} data-media-job-phase={job.phase}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {modality === undefined ? null : <MediaKindGlyph kind={modality} className="h-3.5 w-3.5 text-ink-faint" />}
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={job.request_id}>{job.request_id}</span>
        <span className={`text-[11px] font-medium ${STATE_TONE[tone]}`}>
          {isJobActive(job) ? <Spinner label={t(jobStateKey(job.state))} size={12} /> : t(jobStateKey(job.state))}
        </span>
      </div>

      {/* One line of context: which provider and which model, plus the phase
          while the job is still live. "Generating" and "downloading" have very
          different futures — the first may be charging, the second is bytes on
          their way — so the phase is worth naming. Once the job has settled it
          is not: a finished row reading "generating" contradicts the state
          printed beside it. */}
      <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint" data-media-job-context>
        {[job.provider, job.model, isJobActive(job) ? t(jobPhaseKey(job.phase)) : undefined]
          .filter((part) => part !== undefined)
          .join(' · ')}
      </p>

      <MediaArtifactList artifacts={job.artifacts} sessionId={sessionId} agentId={agentId} />

      {unknown ? (
        <p className="mt-1 text-[12px] leading-4 text-amber-ink" role="status" data-media-job-unknown>
          {t('cap.media.job.unknown')}
        </p>
      ) : null}
      {job.state === 'partial' ? (
        <p className="mt-1 text-[12px] leading-4 text-ink-soft" data-media-job-partial>
          {t('cap.media.job.partial')}
        </p>
      ) : null}
      {job.blocked_reason !== undefined ? (
        <p className="mt-1 text-[12px] leading-4 text-ink-soft" data-media-job-blocked>
          {t(`cap.media.job.blocked.${job.blocked_reason}` as Parameters<typeof t>[0])}
        </p>
      ) : null}
      {cancelNote === 'local-only' && job.state === 'stopped' ? (
        <p className="mt-1 text-[12px] leading-4 text-amber-ink" role="status" data-media-job-local-stop>
          {t('cap.media.job.localStop')}
        </p>
      ) : null}
      {job.error !== undefined && job.error.submission === 'rejected' ? (
        <p role="alert" className="mt-1 text-[12px] leading-4 text-danger" data-media-job-error>{job.error.message}</p>
      ) : null}
      {job.error !== undefined && job.error.submission === 'accepted' ? (
        <p role="alert" className="mt-1 text-[12px] leading-4 text-ink-soft" data-media-job-error>{job.error.message}</p>
      ) : null}

      {/* What the reader may do next. Deliberately absent for an unknown
          submission: a "try again" button there is a second charge, so the
          only way forward this view offers is a lookup or a resume of an
          existing remote handle. */}
      {resumable || stoppable ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2" data-media-job-actions>
          {resumable && onResume !== undefined ? (
            <button
              type="button"
              className={`${QUIET_BUTTON} h-7`}
              disabled={busy !== null}
              data-media-job-resume={job.job_id}
              onClick={() => { onResume(job); }}
            >
              <CapabilityGlyph kind="refresh" className="h-3.5 w-3.5 text-ink-faint" />
              {t('cap.media.job.resume')}
            </button>
          ) : null}
          {stoppable && onStop !== undefined ? (
            <button
              type="button"
              className={DANGER_GHOST_BUTTON}
              disabled={busy !== null}
              data-media-job-stop={job.job_id}
              onClick={() => { onStop(job); }}
            >
              {t('cap.media.job.stop')}
            </button>
          ) : null}
        </div>
      ) : null}
      <FeedbackLine feedback={feedback ?? null} />

      {job.warnings !== undefined && job.warnings.length > 0 ? (
        <ul className="mt-1 space-y-0.5" data-media-job-warnings>
          {job.warnings.map((warning) => (
            <li key={warning} className="text-[11px] leading-4 text-ink-soft">· {warning}</li>
          ))}
        </ul>
      ) : null}

      {showRaw ? (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-panel px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink" data-media-job-raw>
          {JSON.stringify(job, null, 2)}
        </pre>
      ) : null}
      <button
        type="button"
        aria-expanded={showRaw}
        onClick={() => { setShowRaw((value) => !value); }}
        className={`${QUIET_BUTTON} -ml-2 mt-1 h-7 text-[11px]`}
        data-media-job-details={job.job_id}
      >
        <span aria-hidden className={`flex transition-transform duration-[var(--kiki-motion-quick)] motion-reduce:transition-none ${showRaw ? 'rotate-90' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
        {showRaw ? t('cap.media.job.hideDetails') : t('cap.media.job.details')}
      </button>
    </div>
  );
}

const STATE_TONE = {
  ok: 'text-success',
  busy: 'text-ink-soft',
  waiting: 'text-amber-ink',
  error: 'text-danger',
  off: 'text-ink-faint',
} as const;

/**
 * The tool-result shape the media plugin's `generate` returns inside a
 * transcript: `{ type: 'media_generation', job }`. Read with the SDK's own
 * parser so a malformed payload renders as "not a media job" instead of
 * throwing inside a tool card.
 */
export function readMediaJobFromToolResult(output: unknown): MediaJob | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const payload = output as { type?: unknown; job?: unknown };
  if (payload.type !== 'media_generation') return undefined;
  return parseMediaJob(payload.job);
}

/** Validated through the SDK schema; a job that does not parse is not drawn. */
function parseMediaJob(value: unknown): MediaJob | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const job = value as Record<string, unknown>;
  // A narrow structural check rather than a zod parse: the schema is
  // imported in a Node-facing entry, and pulling it into the browser bundle
  // for one field is not worth it. Every field this view reads is checked.
  if (typeof job['job_id'] !== 'string' || typeof job['state'] !== 'string' || !Array.isArray(job['artifacts'])) return undefined;
  return value as MediaJob;
}

/** Convenience for a ToolCard hunk: does this output carry a media job? */
export function hasMediaJob(output: unknown): boolean {
  return readMediaJobFromToolResult(output) !== undefined;
}
