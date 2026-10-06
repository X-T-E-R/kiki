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
import { useSessionRemainderRefs, type ContentContinuationHandle } from './transcriptDetail';

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

export function SessionRemainder({ className = '', handle }: {
  readonly className?: string;
  /**
   * The refs to offer, read outside a `TranscriptDetailProvider` — the
   * composer's footer, which is a sibling of the workspace rather than a
   * descendant of it. The provider-path reader is the default; passing this
   * must carry the *same* controller state, so both outlets are one source and
   * not two copies of it.
   */
  readonly handle?: ContentContinuationHandle | undefined;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const contextHandle = useSessionRemainderRefs();
  const { pending, statusOf, request } = handle ?? contextHandle;
  const sessionRefs = pending.filter((ref) => ref.source.kind === 'snapshot' && ref.path[0] !== 'subagents');
  const rosterRefs = pending.filter((ref) => ref.source.kind === 'roster' || (ref.source.kind === 'snapshot' && ref.path[0] === 'subagents'));
  if (sessionRefs.length === 0 && rosterRefs.length === 0) return null;
  return (
    <section data-session-remainder className={`relative flex flex-col ${className}`.trimEnd()}>
      <button
        type="button"
        data-session-remainder-toggle
        aria-expanded={open}
        onClick={() => { setOpen((value) => !value); }}
        // `leading-4` to match the footer row's own line height: this toggle can
        // now sit in a fixed-height row, and a taller one made the whole footer
        // grow a line instead of staying the height it was.
        className="inline-flex w-fit items-center gap-1.5 text-[12px] leading-4 text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink motion-reduce:transition-none"
      >
        <DisclosureChevron open={open} />
        {t('transcript.content.remainder.summary')}
      </button>
      {open ? (
        // Anchored to the toggle and absolute, so opening this inside the
        // composer's one-line footer does not grow the row and push the card up.
        // The panel opens upward, over the transcript it belongs to.
        <div data-session-remainder-rows className="absolute bottom-full right-0 z-30 mb-1.5 w-72 space-y-1 rounded-lg border border-hairline bg-paper p-2 shadow-lg">
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
