import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { sessionTitlePromptPatch } from '@kiki/session-core/settings';
import { useI18n } from '../../i18n';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { Icon } from '../icons';
import { INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from '../ui';
import { mergeConfigEcho } from './configEcho';
import { FieldIssue } from './SettingsPrimitives';
import {
  sessionTitlePromptState,
  titlePromptDraftDirty,
} from './sessionTitlePromptDraft';

/**
 * The instruction the title model is given.
 *
 * It is read as prose and written as prose, so the editor is a full-width box
 * and the default body is shown as text rather than as a value to copy. Which
 * body is in force is one line of state above the box; the box below is only
 * the custom one, and it is the only editable part of this card.
 *
 * Saving writes one field of `session_title`, so the model, the moments and
 * the toggle on the card above are untouched, and no title request is made:
 * the new body takes effect the next time Kiki writes a title on its own, and
 * titles already written stay as they are.
 */
export function SessionTitlePromptField({ disabled = false }: { disabled?: boolean }) {
  const { client } = useConnection();
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: 60_000 });
  const [draft, setDraft] = useState<string | null>(null);
  const [showDefault, setShowDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const errorId = useId();

  const stored = configQuery.data?.['session_title'];
  const state = sessionTitlePromptState(stored);
  // The editor holds the custom body only. With no override there is nothing
  // to edit, so it opens empty and the built-in body — shown read-only above
  // it — is what is in force. Starting the empty box with a copy of the
  // default would present the same text twice and invite saving it back as an
  // override that changes nothing.
  const saved = state.customPrompt ?? '';
  const dirty = draft !== null && titlePromptDraftDirty(draft, saved);
  const blank = draft !== null && draft.trim() === '';

  // A settled read re-derives the draft only when the stored body actually
  // moved. A box the reader is still typing in is never replaced by the
  // response to their own earlier save.
  useEffect(() => {
    if (configQuery.data !== undefined && !dirty) setDraft(saved);
  }, [configQuery.data, saved, dirty]);

  const write = async (prompt: string | null, ok: string) => {
    setSaving(true);
    setFeedback(null);
    try {
      const latest = await client.getConfig();
      const echoed = await client.patchConfig(sessionTitlePromptPatch(prompt));
      queryClient.setQueryData(['config'], mergeConfigEcho(latest, echoed));
      // Back to what the box now shows, so a save that landed is not offered
      // again on the next render.
      setDraft(prompt ?? '');
      setFeedback({ tone: 'success', text: ok });
    } catch (error) {
      // The draft stays exactly as typed: the box is the reader's work, and a
      // write that did not land is the one moment it must not be taken away.
      setFeedback({ tone: 'error', text: errorText(locale, error) });
    } finally {
      setSaving(false);
    }
  };

  const ready = configQuery.data !== undefined;
  return (
    <div className="space-y-2 py-1" data-session-title-prompt data-prompt-source={state.source}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-ink">
          {t('st.sessionTitlePrompt.source')}
          <span className="text-ink-faint"> · </span>
          {state.source === 'custom'
            ? t('st.sessionTitlePrompt.sourceCustom')
            : t('st.sessionTitlePrompt.sourceDefault')}
        </span>
      </div>

      {/* An old server sends no built-in body. The card still names the body in
          force and the editor still works; only the reference above is absent,
          because a second copy of the default would be a second authority for
          it. It sits where the reference would be, so the reader meets the
          reason before the box rather than after it. */}
      {state.defaultPrompt === undefined ? (
        <Hint>{t('st.sessionTitlePrompt.defaultUnavailable')}</Hint>
      ) : null}

      {state.defaultPrompt !== undefined ? (
        <figure className="space-y-1 rounded-lg border border-hairline bg-hairline/20 p-3">
          <figcaption className="flex items-center gap-2 text-[11px] font-medium text-ink-soft">
            {t('st.sessionTitlePrompt.defaultTitle')}
            <button
              type="button"
              data-session-title-prompt-toggle-default
              className="font-normal text-ink-faint underline-offset-2 transition-colors hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-selected-ink/40 focus-visible:outline-none"
              aria-expanded={showDefault}
              onClick={() => { setShowDefault((open) => !open); }}
            >
              {t(showDefault ? 'st.sessionTitlePrompt.collapse' : 'st.sessionTitlePrompt.expand')}
            </button>
          </figcaption>
          {showDefault ? (
            <p className="max-w-[68ch] whitespace-pre-wrap break-words text-[12px] leading-relaxed text-ink-soft">
              {state.defaultPrompt}
            </p>
          ) : null}
        </figure>
      ) : null}

      {/* The custom body, and the only editable part of this card. Empty means
          "the built-in body is in force", so the box never opens on a copy of
          the default: that would show one text twice and invite saving it back
          as an override that changes nothing. */}
      <>
        <label htmlFor="session-title-prompt" className="block text-[13px] text-ink">
          {t('st.sessionTitlePrompt.customLabel')}
        </label>
        <textarea
          id="session-title-prompt"
          data-session-title-prompt-input
          className={`${INPUT} min-h-32 resize-y font-mono leading-relaxed`}
          value={draft ?? ''}
          disabled={!ready || saving || disabled}
          spellCheck={false}
          placeholder={t('st.sessionTitlePrompt.customPlaceholder')}
          aria-describedby={errorId}
          onChange={(event) => { setDraft(event.target.value); setFeedback(null); }}
        />
        {/* An empty box is only news once something has been written into it:
            an untouched one is just the card waiting, and telling that reader
            that emptiness restores the default would read as a warning about
            the state the card opened in. */}
        <Hint>{blank && dirty
          ? t('st.sessionTitlePrompt.blank')
          : t('st.sessionTitlePrompt.customHelp')}</Hint>
        <FieldIssue id={errorId} text={feedback?.tone === 'error' ? feedback.text : null} />
        <div className="flex flex-wrap items-center gap-2 pt-1" data-settings-actions>
          <button
            type="button"
            data-session-title-prompt-save
            className={`${PRIMARY_BUTTON} inline-flex h-8 items-center gap-1.5`}
            disabled={!ready || !dirty || saving || disabled}
            onClick={() => { void write(blank ? null : draft, t('st.sessionTitlePrompt.saved')); }}
          >
            {t('st.sessionTitlePrompt.save')}
          </button>
          {state.source === 'custom' ? (
            <button
              type="button"
              data-session-title-prompt-restore
              className={`${SECONDARY_BUTTON} inline-flex h-8 items-center gap-1.5`}
              disabled={!ready || saving || disabled}
              onClick={() => { setConfirmRestore(true); }}
            >
              <Icon name="arrowLeft" size={12} />
              {t('st.sessionTitlePrompt.restore')}
            </button>
          ) : null}
        </div>
      </>

      {feedback?.tone === 'success' ? <FeedbackLine feedback={feedback} /> : null}

      <ConfirmDialog
        open={confirmRestore}
        title={t('st.sessionTitlePrompt.restore')}
        body={t('st.sessionTitlePrompt.restoreConfirm')}
        confirmLabel={t('st.sessionTitlePrompt.restore')}
        overlayId="session-title-prompt-restore"
        busy={saving}
        onConfirm={() => {
          setConfirmRestore(false);
          void write(null, t('st.sessionTitlePrompt.restored'));
        }}
        onCancel={() => { setConfirmRestore(false); }}
      />
    </div>
  );
}