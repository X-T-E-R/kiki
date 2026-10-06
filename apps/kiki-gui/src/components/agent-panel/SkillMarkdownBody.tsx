/**
 * The skill's own SKILL.md, read and rendered where the skill is described.
 *
 * A skill is mostly prose, so the detail that describes it in three lines left
 * most of the sheet empty. This reads the same file the preview workspace would
 * open — through the host's own authorized read, never a raw fs call — and
 * renders it as Markdown, which is what a SKILL.md is written in.
 *
 * Read-only by construction: it reads one file and runs nothing. A read either
 * succeeds with the file's bytes or fails at the transport, and this treats it
 * exactly that way: whatever bytes come back *are* the document, because a
 * SKILL.md may legitimately be JSON, and a file that is missing or forbidden
 * arrives as a failed request rather than as a body to be interpreted.
 */

import { useCallback, useEffect, useState } from 'react';

import { useI18n } from '../../i18n';
import { copyTextToClipboard } from '../../lib/clipboard';
import { pushToast } from '../../lib/toasts';
import { useMediaPreview } from '../mediaPreviewContext';
import { useOptionalConnection } from '../../state/connection';
import { Markdown } from '../Markdown';
import { skillReadFailureText } from './mapCapabilities';

type State =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly text: string; readonly truncated: boolean };

export function SkillMarkdownBody({ skill }: {
  readonly skill: { readonly name: string; readonly source?: string; readonly path: string };
}) {
  const { t } = useI18n();
  const client = useOptionalConnection()?.client;
  const preview = useMediaPreview();
  const [state, setState] = useState<State>({ status: 'loading' });
  // A preview that came back cut is shown at once, and the rest of the file is
  // then read on the reader's behalf. `completing` is that second read, and
  // `complete` is its failure, which keeps the prefix that was already read
  // rather than replacing a readable page with an error.
  const [completing, setCompleting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const builtin = skill.source === 'builtin';
  useEffect(() => {
    if (client === undefined) {
      setState({ status: 'error', message: t('diagnostics.unavailable') });
      return undefined;
    }
    let cancelled = false;
    // Both reads belong to one visit of this sheet, so leaving it aborts them
    // in flight and a late answer is dropped rather than painted into whatever
    // the reader is looking at now.
    const abort = new AbortController();
    // Switching skills or retrying starts a fresh read: the sheet never shows
    // the previous skill's text, and a late answer from the old read is
    // dropped rather than painted into the new one.
    setState({ status: 'loading' });
    setCompleting(false);
    setComplete(false);
    const read = builtin
      ? client.readBuiltinSkill(skill.name, { signal: abort.signal }).then((content) => ({ text: content, truncated: false }))
      : client.previewHostFile(skill.path, undefined, { signal: abort.signal }).then((result) => ({ text: result.text, truncated: result.truncated }));
    read.then(
      (result) => {
        if (cancelled) return;
        setState({ status: 'ready', text: result.text, truncated: result.truncated });
        if (!result.truncated) return;
        // The preview is what the reader can see now; the rest is fetched
        // without them asking, because a half SKILL.md is not the document.
        setCompleting(true);
        const whole = client.readHostFile(skill.path, { signal: abort.signal });
        whole.then(
          (full) => {
            // A read that resolved is the file, whatever it holds: an empty
            // file is a file, and it is what the reader's file now says. Only a
            // rejected read is a failure.
            if (cancelled) return;
            setState({ status: 'ready', text: full, truncated: false });
            setCompleting(false);
          },
          // The prefix stays on screen and the reader is told the rest did not
          // arrive, with a way to ask again. Losing what was already read to
          // report a failed follow-up would be the worse of the two outcomes.
          () => {
            if (cancelled) return;
            setCompleting(false);
            setComplete(true);
          },
        );
      },
      // The host answered a failed read with a failed request, so the wire code
      // is the whole of what went wrong. It is translated to the reader's own
      // words here; a code or a host message is never what they are shown.
      (error: unknown) => { if (!cancelled) setState({ status: 'error', message: skillReadFailureText(t, error) }); },
    );
    return () => { cancelled = true; abort.abort(); };
  }, [client, skill.name, skill.path, builtin, attempt, t]);

  const openOriginal = useCallback(() => {
    if (builtin) preview?.openBuiltinSkill(skill.name);
    else preview?.openFile(skill.path);
  }, [preview, builtin, skill.name, skill.path]);

  return (
    <section data-skill-md="" className="space-y-2">
      <header className="flex items-center gap-2 border-b border-hairline pb-1.5">
        <h4 className="font-mono text-[11px] font-semibold uppercase text-ink-faint">
          {t('agentPanel.skillMdSource')}
        </h4>
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          {state.status === 'ready' ? (
            <button
              type="button"
              data-skill-md-copy=""
              onClick={() => {
                // What is copied is exactly what is on screen. The label says
                // which that is, so a reader who copies a still-short prefix is
                // never told they took the whole file.
                void copyTextToClipboard(state.text)
                  .then(() => {
                    pushToast({
                      tone: 'success',
                      text: state.truncated ? t('agentPanel.skillMdCopiedShown') : t('agentPanel.skillMdCopied'),
                    });
                  })
                  .catch((error: unknown) => {
                    pushToast({ tone: 'error', text: `${t('agentPanel.skillMdCopy')}: ${error instanceof Error ? error.message : String(error)}` });
                  });
              }}
              className="rounded px-1.5 py-0.5 text-[11px] text-ink-soft transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink"
            >
              {state.truncated ? t('agentPanel.skillMdCopyShown') : t('agentPanel.skillMdCopy')}
            </button>
          ) : null}
          <button
            type="button"
            data-skill-md-open=""
            onClick={openOriginal}
            disabled={preview === null}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-soft transition-colors hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-selected-ink disabled:cursor-default disabled:text-ink-faint"
          >
            {t('agentPanel.skillMdOpenFile')}
          </button>
        </div>
      </header>

      {state.status === 'loading' ? (
        <p role="status" className="text-[12px] text-ink-faint">{t('agentPanel.loadingSkillMd')}</p>
      ) : state.status === 'error' ? (
        <div role="alert" className="space-y-1.5 text-[12px] text-danger">
          {/* What went wrong, in the reader's words, then the way forward. */}
          <p>{state.message}</p>
          <button
            type="button"
            data-skill-md-retry=""
            onClick={() => { setAttempt((value) => value + 1); }}
            className="underline underline-offset-2 transition-colors hover:text-danger/80"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <>
          {state.truncated ? (
            <p data-skill-md-truncated="" className="text-[11px] text-ink-faint">
              {/* While the rest is on its way the prefix is still being read, so
                  the line says which of the two the reader is looking at. */}
              {completing ? t('agentPanel.skillMdLoadingRest') : t('agentPanel.skillMdTruncated')}
            </p>
          ) : null}
          {complete ? (
            <div role="alert" data-skill-md-incomplete="" className="space-y-1 text-[11px] text-amber-ink">
              <p>{t('agentPanel.skillMdIncomplete')}</p>
              <button
                type="button"
                data-skill-md-complete-retry=""
                onClick={() => { setComplete(false); setAttempt((value) => value + 1); }}
                className="underline underline-offset-2 transition-colors hover:text-amber-ink/80"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : null}
          {/* The drawer body sets 12px; a SKILL.md is written to be read, so
              this block takes the measure and the step the app uses for
              prose, not the control scale around it. */}
          <div data-skill-md-content="" className="text-[12.5px] leading-[1.7] text-ink [&_.kiki-md]:text-[12.5px] [&_.kiki-md_h1]:text-[15px] [&_.kiki-md_h2]:text-[14px] [&_.kiki-md_h3]:text-[13px] [&_.kiki-md_pre]:text-[11px]">
            <Markdown mode="static" text={state.text} />
          </div>
        </>
      )}
    </section>
  );
}
