/**
 * The externally driven session: what the header says, and the two actions
 * that only make sense on such a session.
 *
 * A session driven by an outside client has no Kiki model behind it. So this
 * never names a model, never draws an online dot for a model Kiki cannot see,
 * and never reports the external client's usage as a number. What it does say
 * is the three things a person can act on: which client drives it, that the
 * external conversation itself is not here, and the one action that moves the
 * work into Kiki.
 *
 * The composer for such a session saves a note instead of sending a prompt
 * (see `ExternalNoteComposer`), and "Continue in Kiki" starts a local branch
 * that keeps the external session and its sub agents running and owned by the
 * person who started them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { writeDraft } from '@kiki/session-core/composer';
import { errorText, type I18nKey } from '@kiki/session-core/i18n';

import { useI18n } from '../../i18n';
import {
  externalClientsFacade,
  materialsStateOf,
  readExternalClientMark,
  sessionHref,
  type ExternalClientMaterialsPreview,
  type ExternalClientSessionMark,
  type ExternalClientTextReceipt,
  type ExternalTextKind,
} from '../../lib/externalClients';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { DisclosureChevron, Icon } from '../icons';
import { INPUT, SECONDARY_BUTTON } from '../ui';

/**
 * What kind of material a row is. The server sends `saved_text` or
 * `tool_record`; the text kind travels separately as `recordKind`, so a saved
 * excerpt keeps saying whether it was a note or a user excerpt.
 */
const MATERIAL_KIND_KEY: Record<'saved_text' | 'tool_record', I18nKey> = {
  saved_text: 'st.xs.savedRecord',
  tool_record: 'st.xs.materialToolRecord',
};

/** The four kinds a client can save, as literal keys: `I18nKey` is a union, not a pattern. */
const TEXT_KIND_KEY: Record<ExternalTextKind, I18nKey> = {
  note: 'st.xs.savedKind.note',
  user_excerpt: 'st.xs.savedKind.user_excerpt',
  assistant_excerpt: 'st.xs.savedKind.assistant_excerpt',
  handoff: 'st.xs.savedKind.handoff',
};

/** The session's own metadata, or undefined when it is an ordinary session. */
export function useExternalClientMark(sessionMetadata: unknown): ExternalClientSessionMark | undefined {
  return useMemo(() => readExternalClientMark(sessionMetadata), [sessionMetadata]);
}

/**
 * The header mark: which client drives this session, and the two facts that
 * would otherwise be guessed at — the external conversation is not synced
 * here, and Kiki did not run a model for it.
 *
 * It is a quiet outlined mark in the same family as the external-harness mark
 * beside it, and opening it is the only place either fact is stated at length.
 * Nothing here is a control.
 */
export function ExternalClientMark({ mark }: { mark: ExternalClientSessionMark }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // The panel is a child of this container, so a pointerdown is judged against
  // the container rather than against the window the listener is attached to.
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target) !== true) setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open]);
  return (
    <span ref={rootRef} className="relative hidden shrink-0 self-center sm:inline-flex">
      <button type="button" data-xs-mark aria-expanded={open}
        title={t('st.xs.sourceTitle', { client: mark.clientName })}
        onClick={() => { setOpen((value) => !value); }}
        className="inline-flex h-[18px] max-w-[14rem] items-center gap-1 rounded-[5px] border border-hairline-strong px-1.5 text-[11px] leading-none font-medium text-ink-soft transition-colors hover:border-ink-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-selected-ink">
        <Icon name="external" size={12} className="shrink-0 text-ink-faint" />
        <span className="truncate">{t('st.xs.source')}</span>
        <span className="truncate font-normal text-ink-faint">{mark.clientName}</span>
      </button>
      {open ? (
        <div data-xs-mark-panel role="dialog" aria-label={t('st.xs.drivenByNamed', { client: mark.clientName })}
          className="anim-enter absolute top-full right-0 z-40 mt-1.5 w-72 rounded-[10px] border border-hairline bg-panel p-3 shadow-[0_1px_2px_rgb(var(--kiki-shadow-ink)/0.06),0_8px_24px_-12px_rgb(var(--kiki-shadow-ink)/0.18)]">
          <p className="text-[12.5px] font-medium text-ink">{t('st.xs.drivenByNamed', { client: mark.clientName })}</p>
          <p data-xs-model-unknown className="mt-1 text-[12px] leading-snug text-ink-soft">{t('st.xs.modelUnknown')}</p>
          {/* The honesty line, placed where a reader looks for the model. */}
          <p data-xs-usage-unknown className="mt-1 text-[12px] leading-snug text-ink-faint">{t('st.xs.usageUnknown')}</p>
          <p className="mt-2 border-t border-hairline pt-2 text-[12px] leading-snug text-ink-soft">{t('st.xs.drivenNote')}</p>
          <p className="mt-1.5 font-mono text-[11px] text-ink-faint">{mark.sessionRef}</p>
        </div>
      ) : null}
    </span>
  );
}

/** The one-line version of the same fact, for the page above the transcript. */
export function ExternalClientBanner({ mark }: { mark: ExternalClientSessionMark }) {
  const { t } = useI18n();
  return (
    <p data-xs-banner className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-faint">
      <Icon name="external" size={12} className="shrink-0" />
      <span className="text-ink-soft">{t('st.xs.drivenByNamed', { client: mark.clientName })}</span>
      <span aria-hidden>·</span>
      <span>{t('st.xs.drivenNote')}</span>
    </p>
  );
}

/**
 * The composer for an externally driven session. It saves a note into this
 * session and sends nothing anywhere: pressing Enter cannot reach the client
 * and cannot start a local model, because doing either without being asked is
 * the failure this surface exists to prevent.
 *
 * The idempotency key is stable per draft, so a retry after a lost response
 * does not create a second copy of the same note.
 */
export function ExternalNoteComposer({ sessionId, disabled = false }: {
  sessionId: string;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const api = useMemo(() => externalClientsFacade(client.klient), [client]);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ExternalTextKind>('note');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [receipt, setReceipt] = useState<ExternalClientTextReceipt | undefined>();
  // One key per draft: a retry reuses it, a new note gets a new one.
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());

  const save = useCallback(async () => {
    const body = text.trim();
    if (body === '') {
      setFeedback({ tone: 'error', text: t('st.xs.noteEmpty') });
      return;
    }
    if (api === undefined) {
      setFeedback({ tone: 'error', text: t('st.xc.unsupported') });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const result = await api.saveText(sessionId, {
        text: body,
        kind,
        idempotencyKey: draftKey,
        title: title.trim() === '' ? undefined : title.trim(),
      });
      setReceipt(result);
      setText('');
      setTitle('');
      setDraftKey(crypto.randomUUID());
      setFeedback({
        tone: 'success',
        text: result.duplicate ? t('st.xs.noteDuplicate', { id: result.recordId }) : t('st.xs.noteSaved'),
      });
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xs.error.saveText', { reason: errorText(locale, error) }) });
    } finally {
      setBusy(false);
    }
  }, [api, draftKey, kind, locale, sessionId, t, text, title]);

  return (
    <div data-xs-note-composer className="space-y-2">
      <label className="sr-only" htmlFor="xs-note">{t('st.xs.composerNoteTitle')}</label>
      <textarea id="xs-note" data-xs-note rows={3} disabled={disabled || busy} value={text}
        className={`${INPUT} min-h-[4.5rem] resize-y`}
        placeholder={t('st.xs.notePlaceholder')}
        onChange={(event) => { setText(event.target.value); }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) return;
          event.preventDefault();
          void save();
        }} />
      <div className="flex flex-wrap items-center gap-2">
        <input data-xs-note-title className={`${INPUT} min-w-0 flex-1`} value={title} disabled={disabled || busy}
          placeholder={t('st.xs.noteTitle')}
          onChange={(event) => { setTitle(event.target.value); }} />
        <select data-xs-note-kind className={`${INPUT} sm:w-auto`} value={kind}
          disabled={disabled || busy}
          onChange={(event) => { setKind(event.target.value as ExternalTextKind); }}>
          {(['note', 'user_excerpt', 'assistant_excerpt', 'handoff'] as const).map((value) => (
            <option key={value} value={value}>{t(TEXT_KIND_KEY[value])}</option>
          ))}
        </select>
        <button type="button" data-xs-note-save className={SECONDARY_BUTTON} disabled={disabled || busy} aria-busy={busy}
          onClick={() => { void save(); }}>
          {busy ? t('st.xs.noteSaving') : t('st.xs.noteSave')}
        </button>
      </div>
      {/* An excerpt is a source, not a verified message. Saying so once, next
          to the control that sets the kind, prevents the wrong reading. */}
      <p className="text-[12px] leading-4 text-ink-faint">{t('st.xs.savedKindHint')}</p>
      <FeedbackLine feedback={feedback} />
      {receipt !== undefined ? (
        <p data-xs-note-receipt className="font-mono text-[11px] text-ink-faint">{receipt.recordId}</p>
      ) : null}
    </div>
  );
}

/**
 * The composer an externally driven session gets instead of the prompt box.
 *
 * It occupies the same place in the page and does the same kind of thing the
 * composer does — one line saying what this is, one place to write — but it
 * cannot reach a model, because no Kiki model runs this session. The note
 * saves into the session; "Continue in Kiki" is the one action that starts
 * local work, and it is deliberately a separate button rather than what Enter
 * does.
 */
export function ExternalSessionComposer({ sessionId, mark, materialsPreview, busy, disabled }: {
  sessionId: string;
  mark: ExternalClientSessionMark;
  /** The server's bounded read of what a local branch would carry. */
  materialsPreview: ExternalClientMaterialsPreview | undefined;
  busy?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [continuing, setContinuing] = useState(false);
  return (
    <div className="group/composer px-6 pb-5" data-xs-composer data-composer-variant="external">
      <div className="composer-card relative rounded-[18px] bg-panel p-3 shadow-[var(--kiki-sheet-shadow)]">
        <ExternalClientBanner mark={mark} />
        <div className="mt-2.5">
          <ExternalNoteComposer sessionId={sessionId} disabled={disabled === true || busy === true} />
        </div>
        {/* Continuing is the one way to local work, but it is not what the
            composer is for, so it stays closed until asked for. */}
        <details data-xs-continue-disclosure className="mt-2 border-t border-hairline pt-2">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-soft outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-selected-ink [&::-webkit-details-marker]:hidden">
            <DisclosureChevron open={false} className="text-ink-faint transition-transform group-open/xc:rotate-90" />
            {t('st.xs.continueAction')}
          </summary>
          <div className="pt-2">
            <ContinueInKiki sessionId={sessionId} preview={materialsPreview}
              busy={disabled} onStarted={() => { setContinuing(true); }} />
          </div>
        </details>
        {continuing ? <span className="sr-only">{t('st.xs.continueStarted')}</span> : null}
      </div>
    </div>
  );
}

/**
 * "Continue in Kiki": start a local branch from what this session saved.
 *
 * It calls the fork path and nothing else. The external session keeps its
 * records and its running sub agents, and the new branch starts with an
 * ordinary composer, so the person picks a model and sends the first prompt
 * themselves. Creating the branch is one click; choosing what happens next is
 * deliberately theirs.
 */
export function ContinueInKiki({ sessionId, preview, busy, onStarted }: {
  sessionId: string;
  /** The server's bounded read of what the branch would carry. */
  preview: ExternalClientMaterialsPreview | undefined;
  busy?: boolean;
  onStarted?: (sessionId: string) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const api = useMemo(() => externalClientsFacade(client.klient), [client]);
  const navigate = useNavigate();
  const materialsState = materialsStateOf(preview);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [goal, setGoal] = useState('');

  const start = async () => {
    if (api === undefined) {
      setFeedback({ tone: 'error', text: t('st.xc.unsupported') });
      return;
    }
    setWorking(true);
    setFeedback(null);
    try {
      const result = await api.continue(sessionId);
      // The goal is pre-filled into the new branch's composer through the
      // draft the composer already reads. It is never sent: the branch opens
      // with the text waiting, and the person presses send themselves.
      if (goal.trim() !== '') writeDraft(result.sessionId, goal.trim());
      setFeedback({ tone: 'success', text: t('st.xs.continueStarted') });
      onStarted?.(result.sessionId);
      // The app's session route is `/s/:id`. A path that misses it does not
      // fail loudly — it falls through to the session list, so the branch that
      // was just created looks like it never happened.
      void navigate(sessionHref(result.sessionId));
    } catch (error) {
      setFeedback({ tone: 'error', text: t('st.xs.error.continue', { reason: errorText(locale, error) }) });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div data-xs-continue className="space-y-2">
      <p className="max-w-[62ch] text-[12px] leading-4 text-ink-soft">{t('st.xs.continueHint')}</p>
      {/* What the branch starts from, so "continue" is not a leap of faith.
          Three states, because "we have not read it" and "there is nothing"
          are different facts and this surface must not collapse them. */}
      <div data-xs-continue-materials data-xs-materials-state={materialsState} className="space-y-1">
        <p className="text-[12px] text-ink-faint">{t('st.xs.continueMaterials')}</p>
        {preview === undefined ? (
          <p data-xs-continue-unknown className="text-[12px] leading-4 text-ink-faint">
            {t('st.xs.continueMaterialsUnavailable')}
          </p>
        ) : preview.items.length === 0 ? (
          /* Only a complete read with nothing in it may read as empty; a
             partial or unloaded read says it could not finish the list. */
          preview.state === 'complete'
            ? <p data-xs-continue-empty className="text-[12px] leading-4 text-ink-faint">{t('st.xs.continueMaterialsNone')}</p>
            : <p data-xs-continue-unknown className="text-[12px] leading-4 text-ink-faint">{t('st.xs.continueMaterialsPartial')}</p>
        ) : (
          <ul className="space-y-1">
            {preview.items.map((material) => (
              <li key={material.id} data-xs-material={material.id} data-xs-material-kind={material.kind}
                className="rounded-md border border-hairline bg-paper px-2 py-1.5">
                {/* The server's own title when it sent one, else the kind.
                    The source client is named on every row, because a record
                    without its source reads as something the user said. */}
                <p className="truncate text-[11px] text-ink-faint">
                  {material.title.trim() === '' ? t(MATERIAL_KIND_KEY[material.kind]) : material.title}
                  {material.recordKind !== undefined
                    ? <span> · {t(TEXT_KIND_KEY[material.recordKind])}</span>
                    : null}
                  <span> · {t('st.xs.savedByClient', { client: material.source.clientName })}</span>
                </p>
                <p className="mt-0.5 line-clamp-3 text-[12.5px] leading-5 text-ink-soft">{material.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
        {preview !== undefined && preview.state !== 'complete' ? (
          <p data-xs-continue-partial className="text-[12px] leading-4 text-ink-faint">
            {t('st.xs.continueMaterialsPartial', {
              count: preview.knownTotal ?? preview.items.length,
              shown: preview.items.length,
            })}
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <label className="block text-[12px] text-ink-soft" htmlFor="xs-continue-goal">{t('st.xs.continueGoalLabel')}</label>
        <input id="xs-continue-goal" data-xs-continue-goal className={INPUT} value={goal} disabled={working || busy}
          placeholder={t('st.xs.continueGoalPlaceholder')}
          onChange={(event) => { setGoal(event.target.value); }} />
        <p className="text-[12px] leading-4 text-ink-faint">{t('st.xs.continueModelHint')}</p>
      </div>
      <button type="button" data-xs-continue-start className={SECONDARY_BUTTON}
        disabled={working || busy} aria-busy={working}
        onClick={() => { void start(); }}>
        {working ? t('st.xs.continueWorking') : t('st.xs.continueAction')}
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
