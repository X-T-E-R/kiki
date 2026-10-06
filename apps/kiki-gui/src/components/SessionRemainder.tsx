/**
 * What the last window did not carry of the session itself — the snapshot
 * fields the header shows (a cut title, a cut cwd) and the agent roster the
 * list is built from. Those refs hang off no rendered body, so their outlet
 * belongs at the end of the reading column, after the last existing row: one
 * quiet summary line, and one row per structure once opened. The controller
 * follows roster array pages automatically; this outlet reports progress or
 * offers recovery. Other fields retain their one-segment action. With no
 * visible refs left, the section renders nothing, including on a blank transcript.
 *
 * Labels name what the reader is missing, never a source or a path.
 */

import { useState, type ReactNode } from 'react';

import type { ContentRef } from '@kiki/transcript';

import { DisclosureChevron } from './icons';
import { useI18n } from '../i18n';
import { ContinuationRow, contentRefProgress } from './ContentContinuation';
import { useSessionRemainderRefs } from './transcriptDetail';

/** One structure's unread refs, in the same row shape as a body's continuation. */
function StructuralRow({
  kind,
  label,
  refs,
  statusOf,
  onRequest,
}: {
  readonly kind: string;
  readonly label: string;
  readonly refs: readonly ContentRef[];
  readonly statusOf: (ref: ContentRef) => { readonly status: 'idle' | 'loading' | 'error' } | undefined;
  readonly onRequest: (ref: ContentRef) => void;
}): ReactNode {
  const { t, tp } = useI18n();
  const ref = refs[0];
  if (ref === undefined) return null;
  const progress = contentRefProgress(ref, t);
  if (kind === 'agents' && ref.source.kind === 'snapshot' && ref.path.length === 1 && ref.kind === 'array' && statusOf(ref)?.status !== 'error') {
    return <p role="status" data-roster-reading className="text-[12px] leading-5 text-ink-faint">
      {label} · {progress} · {t('transcript.content.remainder.readingAgents')}
    </p>;
  }
  return (
    <ContinuationRow
      kind={kind}
      state={statusOf(ref)?.status ?? 'idle'}
      progress={refs.length > 1
        ? `${label} · ${progress} · ${tp('transcript.content.morePending', refs.length - 1)}`
        : `${label} · ${progress}`}
      error={t('transcript.content.failed')}
      label={label}
      onRequest={() => { onRequest(ref); }}
    />
  );
}

export function SessionRemainder({ className = '' }: { readonly className?: string }): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { pending, statusOf, request } = useSessionRemainderRefs();
  const sessionRefs = pending.filter((ref) => ref.source.kind === 'snapshot' && ref.path[0] !== 'subagents');
  const rosterRefs = pending.filter((ref) => ref.source.kind === 'roster' || (ref.source.kind === 'snapshot' && ref.path[0] === 'subagents'));
  if (sessionRefs.length === 0 && rosterRefs.length === 0) return null;
  return (
    <section data-session-remainder className={`flex flex-col ${className}`.trimEnd()}>
      <button
        type="button"
        data-session-remainder-toggle
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        className="inline-flex w-fit items-center gap-1.5 text-[12px] leading-5 text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink motion-reduce:transition-none"
      >
        <DisclosureChevron open={open} />
        {t('transcript.content.remainder.summary')}
      </button>
      {open ? (
        <div data-session-remainder-rows className="mt-1.5 space-y-1">
          <StructuralRow
            kind="session"
            label={t('transcript.content.remainder.session')}
            refs={sessionRefs}
            statusOf={statusOf}
            onRequest={request}
          />
          <StructuralRow
            kind="agents"
            label={t('transcript.content.remainder.agents')}
            refs={rosterRefs}
            statusOf={statusOf}
            onRequest={request}
          />
        </div>
      ) : null}
    </section>
  );
}

/** True while the session still holds a visible structure no window delivered. */
export function useSessionRemainderPending(): boolean {
  return useSessionRemainderRefs().pending.length > 0;
}
