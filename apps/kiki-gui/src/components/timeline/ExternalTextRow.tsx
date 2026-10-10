/**
 * Text an external client saved into the session (`external.text`).
 *
 * It is a record the client handed over on purpose, not a turn: it never wears
 * a user or assistant bubble, because a `user_excerpt` is the client passing on
 * what a person said in *its* chat, and showing that as a user turn would put
 * words in this session's user's mouth. So it sits in the activity lane like
 * the other things that happened, one line naming the kind and the client that
 * saved it, opening onto the saved body rendered as markdown — the same reader
 * the rest of the timeline uses, so pasted code and lists read as themselves.
 *
 * Opening is the whole read request. The marker is a bounded window like any
 * other long body, so a body past the budget arrives as a prefix plus a content
 * ref; the continuation row below it reads the rest on demand through the same
 * controller the tool results use. Nothing here re-implements reading, and the
 * prefix is never presented as if it were the complete record.
 */

import { memo, useState } from 'react';

import type { I18nKey } from '@kiki/session-core/i18n';
import type { ExternalTextNote } from '@kiki/session-core/session';

import { useI18n } from '../../i18n';
import { ContentContinuation } from '../ContentContinuation';
import { Markdown } from '../Markdown';
import { Icon } from '../icons';
import { ActivityRow, ACTIVITY_GUTTER } from './ActivityRow';
import { RelativeTime } from '../RelativeTime';

const KIND_KEY = {
  note: 'st.xs.savedKind.note',
  user_excerpt: 'st.xs.savedKind.user_excerpt',
  assistant_excerpt: 'st.xs.savedKind.assistant_excerpt',
  handoff: 'st.xs.savedKind.handoff',
} as const satisfies Record<ExternalTextNote['kind'], I18nKey>;

/** The cut body lives under the marker's `payload`, where the server put it. */
const ROOTS = ['payload'] as const;

export const ExternalTextRow = memo(function ExternalTextRow({
  note,
  createdAt,
}: {
  note: ExternalTextNote;
  createdAt?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const kind = t(KIND_KEY[note.kind]);
  // The title is the client's own label; the kind is the honest fallback, and
  // the client is named on the row so a bare record is never anonymous.
  const headline = note.title === undefined || note.title.trim() === '' ? kind : note.title;
  // The marker's own id, never the `agent-marker-…` display id: this address
  // goes to the server, and only the real one names a body to read.
  const source = { kind: 'marker' as const, id: note.markerId };
  return (
    <div data-xs-external-text data-xs-external-text-kind={note.kind} data-xs-external-text-open={open}>
      <ActivityRow
        glyph={<Icon name="external" size={12} />}
        label={<span className="truncate">{headline}</span>}
        detail={<span className="truncate">{note.source.clientName} · {kind}</span>}
        meta={createdAt === undefined ? undefined : <RelativeTime at={createdAt} />}
        expanded={open}
        chevronInGlyph
        onToggle={() => { setOpen((value) => !value); }}
        buttonAttrs={{ 'data-xs-external-text-toggle': true }}
      />
      {open ? (
        <div data-xs-external-text-body className={`${ACTIVITY_GUTTER} mt-1 space-y-1.5`}>
          <p className="text-[12px] text-ink-faint">
            {t('st.xs.savedByClient', { client: note.source.clientName })}
            {note.sourceUrl === undefined ? null : (
              <> · <a href={note.sourceUrl} target="_blank" rel="noreferrer noopener"
                className="underline decoration-dotted underline-offset-2 hover:text-ink-soft">{note.sourceUrl}</a></>
            )}
          </p>
          <div className="text-[13px] leading-6 text-ink-soft">
            <Markdown text={note.text} />
          </div>
          <ContentContinuation source={source} roots={ROOTS} label={kind} />
        </div>
      ) : null}
    </div>
  );
});
