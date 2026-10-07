/**
 * The author workbench for one Recipe package.
 *
 * The page title is the package, not the model: this is a place to change a
 * recipe, and a model is only one of the things that may later use it. That is
 * also why saving here never binds anything — `saveLocal` returns a new
 * revision and this page keeps editing it. Binding is a separate, explicit
 * action on the model.
 *
 * Prose comes first. What an author wants to change is the words, so the prompt
 * text and the steering text are both editable in one view, both open, and an
 * empty one is still editable rather than hidden behind an "add" affordance.
 * The manifest is the advanced view of the same buffer, not a second object.
 *
 * Every write goes back as the complete file map. `saveLocal` validates the
 * whole package on the server, so sending only the file that changed would
 * offer it an incomplete package and let it reject a good edit for a missing
 * Markdown file.
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { ConfirmDialog } from '../ConfirmDialog';
import { useDirtyGuard, useDirtyReporter } from '../dirtyGuard';

import { errorText, type I18nKey } from '@kiki/session-core/i18n';
import type { ModelSteeringSource } from '@kiki/protocol';

import { useI18n } from '../../i18n';
import { isRecipeHookConsentRequired, recipeConsentField, recipeHookEventKey, recipePreviewNeedsConsent } from '../../lib/recipeHooks';
import {
  RECIPE_MANIFEST, RecipeManifestError, manifestWouldReformat, parseRecipeManifest,
  readDeclaration, referencedFiles, renderManifest, writeSlot, writeSteeringSource,
  type RecipeDeclarationView, type SlotDeclaration, type SegmentDeclaration, type SteeringSourceDeclaration,
} from '../../lib/recipeFiles';
import { recipeRevisionShort, type RecipeDetail, type RecipePreview } from '../../lib/recipes';
import { useRecipeMutation } from '../../lib/recipeQueries';
import { useConnection } from '../../state/connection';
import { FeedbackLine, type Feedback } from '../controls';
import { CodeEditor } from '../CodeEditor';
import { Chevron } from '../Chevron';
import { SettingsSegmented, SettingsSelect } from './SettingsPrimitives';
import { STEER_SOURCES } from './modelSteerSourceDraft';
import { SMALL_INPUT } from '../ui';
import { RecipeHookConsentBody } from './RecipeHookScripts';

type AuthorTab = 'prompt' | 'source';
type SaveInput = { installation_id: string; expected_revision: string; files: Record<string, string> };

/** Compare bytes and path presence, not the order a file map was assembled in. */
function sameFiles(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every((path) => Object.hasOwn(right, path) && left[path] === right[path]);
}

/** Changed, added and deleted paths stay local; untouched paths adopt accepted bytes. */
export function mergePublished(accepted: Record<string, string>, sent: Record<string, string>, current: Record<string, string>): Record<string, string> {
  const merged = { ...accepted };
  for (const path of new Set([...Object.keys(sent), ...Object.keys(current)])) {
    if (Object.hasOwn(current, path) === Object.hasOwn(sent, path) && current[path] === sent[path]) continue;
    if (Object.hasOwn(current, path)) merged[path] = current[path]!;
    else delete merged[path];
  }
  return merged;
}

/** The slots an author edits as prose, in the order they reach the model. */
const PROSE_SLOTS = [
  { slot: 'system', label: 'st.recipe.slot.system' },
  { slot: 'steering', label: 'st.recipe.slot.steering' },
] as const;

export function RecipeAuthorWorkbench({ detail, onApplied, onBack, onDirtyChange }: {
  detail: RecipeDetail;
  /** The accepted package and whether newer words still need this workbench. */
  onApplied: (next: RecipeDetail, hasDraft: boolean) => void;
  onBack: () => void;
  /** Words typed into the package and not yet saved. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const queryClient = useQueryClient();
  // The returned detail is the editor's source of truth after any write: its
  // revision and files are what the next save must carry, and a stale cache
  // would make the next save fail against a revision that no longer exists.
  const [files, setFiles] = useState<Record<string, string>>(() => ({ ...detail.files }));
  /* Cache invalidation can await between a response and its completion callback. */
  const liveFiles = useRef(files);
  liveFiles.current = files;
  const [baselineFiles, setBaselineFiles] = useState<Record<string, string>>(() => ({ ...detail.files }));
  // Bumped only when the editor's content is replaced from outside — the first
  // load and each accepted save. Typing must not change it, or the editor would
  // be rebuilt on every keystroke and lose the caret and undo history.
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<AuthorTab>('prompt');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [manifestProblem, setManifestProblem] = useState<string | null>(null);
  const [reformatNeeded, setReformatNeeded] = useState(false);
  // A save that failed for a reason other than a refused script, or a consent
  // that was declined: the draft stays exactly as typed and the reason lands
  // next to it.
  const [failure, setFailure] = useState<string | null>(null);

  const manifestText = files[RECIPE_MANIFEST] ?? '';
  const dirty = !sameFiles(files, baselineFiles);
  // Whoever opened this editor decides what leaving means, so the workbench
  // reports its draft rather than deciding on its own. Closing the model panel
  // and pressing Back lose the same words.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const draftId = `recipe-author:${detail.summary.installation_id}`;
  useDirtyReporter(draftId, dirty);
  const guard = useDirtyGuard();
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const leave = () => {
    if (guard?.confirmDiscard !== undefined) { guard.confirmDiscard(draftId, onBack); return; }
    if (dirty) { setConfirmingLeave(true); return; }
    onBack();
  };

  let declaration: RecipeDeclarationView | undefined;
  let parseError: string | undefined;
  try {
    declaration = readDeclaration(parseRecipeManifest(manifestText));
  } catch (error) {
    parseError = error instanceof RecipeManifestError ? error.message : String(error);
  }
  // Whether the manifest parses is a fact about the text, not render-time state.
  // Writing it here would re-enter render, which React refuses as a loop.
  useEffect(() => {
    setManifestProblem(parseError ?? null);
  }, [parseError]);

  /*
    Saving a package whose script changed arrives here as a validation failure
    carrying one code. That is the same decision the install path already knows
    how to ask, so it is answered the same way: re-preview the edited package,
    show the commands in the confirmation the save was always going to need, and
    publish through the one install route the contract names. Nothing is written
    until the person agrees. The press snapshot is what gets confirmed and
    saved; newer typing stays in the editor as an unsaved draft.
  */
  const [consentPreview, setConsentPreview] = useState<RecipePreview | null>(null);
  /*
    The read-back step.
    A save that goes through consent answers with the summary it published, not
    with the package. Reading the package back is what makes the editor's files
    and revision true again, and it is what keeps the next save pointing at a
    revision that exists — so if it fails, the package *was* saved and only this
    view is behind. That is a different situation from a failed save, and it is
    reported as one: a failure line that says "not saved" here would send the
    person back to press Save again with the revision they just replaced, and the
    next write would be refused for a reason that has nothing to do with their edit.

    A read that answers "no such package" is not a success either. The install
    reported a package it published, so an absent read means the server could not
    be asked about it — the same situation as a failed read, with the same retry,
    rather than a silent success that leaves the editor on a revision the server
    has already replaced.
  */
  const [unreadSave, setUnreadSave] = useState<string | null>(null);
  // Why a read did not answer, shown beside the retry rather than as a write failure.
  const [reloadReason, setReloadReason] = useState<string | null>(null);

  /*
    What was handed to the server, captured at the press.

    The read that follows a publish is not instantaneous, and an editor is not a
    form that locks itself while a request is in flight. A person can keep typing
    across that window, and those words are not part of what was published. So
    the editor keeps a copy of the exact buffer that was sent, and the read merges
    against it: a file still holding the sent bytes was not touched while the
    request was in flight, so the server's copy is the current one; a file that
    changed since is the person's own, and the server has never seen it.

    Restoring the published files wholesale would silently discard work the
    server never had, which is the one outcome a draft mechanism exists to
    prevent.
  */
  const sentAtPublish = useRef<SaveInput | null>(null);

  /*
    Both publish routes reconcile the same three maps and tell the parent
    whether leaving would lose newer work. Read the live buffer even when an
    earlier callback is still awaiting query invalidation.
  */
  const acceptPublished = (saved: RecipeDetail, sent: Record<string, string>) => {
    const merged = mergePublished(saved.files, sent, liveFiles.current);
    setFiles(merged);
    setBaselineFiles({ ...saved.files });
    setGeneration((current) => current + 1);
    setUnreadSave(null);
    setReloadReason(null);
    setFailure(null);
    setFeedback({ tone: 'success', text: t('st.recipe.savedNewBinding') });
    queryClient.setQueryData(['recipe', saved.summary.installation_id], saved);
    sentAtPublish.current = null;
    onApplied(saved, !sameFiles(merged, saved.files));
  };

  const readSaved = useRecipeMutation(
    (installationId: string) => client.getRecipe(installationId),
    {
      onSuccess: (saved, installationId) => {
        if (saved === undefined) {
          /* Only a successful read may consume the original merge baseline. */
          setUnreadSave(installationId);
          return;
        }
        const sent = sentAtPublish.current;
        if (sent !== null) acceptPublished(saved, sent.files);
      },
      onError: (error) => {
        /* The write landed; this failure needs a read, not another publish. */
        setUnreadSave(sentAtPublish.current!.installation_id);
        // Kept off the failure line on purpose. That line sits above the Save
        // row in the danger colour and reads as "the write did not happen",
        // which is the opposite of what is true here and would send the person
        // looking for an edit to redo. The reason belongs with the retry.
        setReloadReason(errorText(locale, error));
      },
    },
  );

  const save = useRecipeMutation(
    (input: SaveInput) => {
      /* Keep the mutation's bytes even if the refusal arrives after more input. */
      sentAtPublish.current = input;
      return client.saveLocalRecipe(input);
    },
    {
      onSuccess: (saved, input) => {
        setConsentPreview(null);
        acceptPublished(saved, input.files);
      },
      onError: (error) => {
        if (isRecipeHookConsentRequired(error)) {
          /* Preview the refused press, never whatever was typed afterwards. */
          setFailure(null);
          previewForConsent.mutate(sentAtPublish.current!);
          return;
        }
        /* Nothing landed, so the draft and its revision remain unchanged. */
        sentAtPublish.current = null;
        setUnreadSave(null);
        setFeedback({ tone: 'error', text: t('st.recipe.saveFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  const previewForConsent = useRecipeMutation(
    (input: { installation_id: string; expected_revision: string; files: Record<string, string> }) => client.previewRecipe({
      source: { locator: `installation:${input.installation_id}` },
      installation_id: input.installation_id,
      expected_revision: input.expected_revision,
      files: input.files,
    }),
    {
      onSuccess: (previewed) => {
        setFailure(null);
        // A preview that says it does not need consent still has to be
        // published, but through the plain install: the save it replaced would
        // have been accepted as-is.
        if (recipePreviewNeedsConsent(previewed)) setConsentPreview(previewed);
        else void installWithConsent.mutate({ preview: previewed });
      },
      onError: (error) => {
        setUnreadSave(null);
        setFailure(t('st.recipe.previewFailed', { detail: errorText(locale, error) }));
      },
    },
  );

  const installWithConsent = useRecipeMutation(
    (input: { preview: RecipePreview }) => client.installRecipe({
      preview_id: input.preview.preview_id,
      ...recipeConsentField(input.preview),
    }),
    {
      onSuccess: (summary) => {
        setConsentPreview(null);
        setFailure(null);
        // The read reports its own outcome through `readSaved`: a rejection
        // here is already reflected in the unread-save notice, so it is only
        // swallowed to keep it from becoming an unhandled rejection.
        void readSaved.mutateAsync(summary.installation_id).catch(() => {});
      },
      onError: (error) => {
        // Nothing was published, so the package is still where the person left
        // it and the draft is still the draft.
        setUnreadSave(null);
        setFailure(t('st.recipe.saveFailed', { detail: errorText(locale, error) }));
      },
    },
  );

  /*
    Two different states, kept apart.

    `writing` is a request actually in flight. `blocked` is this view being
    unable to start a correct write: a confirmation is open, or the last publish
    has not been read back yet. Only the first one is busy work, and only the
    first one earns a "Saving…" label — a button that says it is saving while it
    sits waiting for someone to read a dialog or press a retry is lying about
    what it is doing. Both disable the press, for different reasons.
  */
  const writing = save.isPending || previewForConsent.isPending || installWithConsent.isPending
    || readSaved.isPending;
  const blocked = consentPreview !== null || unreadSave !== null;
  const saveDisabled = writing || blocked;

  /** Write one slot's prose back into the manifest and into any file it owns. */
  const setSlot = (group: 'prompts' | 'main' | 'independent', slot: 'system' | 'steering', value: SlotDeclaration) => {
    if (parseError !== undefined) return;
    const nextManifest = writeSlot(parseRecipeManifest(manifestText), group, slot, value);
    const rendered = renderManifest(nextManifest);
    setFiles((current) => ({ ...current, [RECIPE_MANIFEST]: rendered }));
    setReformatNeeded(manifestWouldReformat(manifestText, rendered));
  };

  /**
   * Write a referenced Markdown file, which is a buffer of its own.
   *
   * The notice about formatting belongs to the manifest, and this does not
   * touch the manifest. It used to clear the notice, which meant that editing a
   * Markdown file after a declaration change silently removed a warning about
   * a manifest that was still sitting there rewritten. Only a write that
   * actually re-serializes the manifest may set or clear it.
   */
  const setFileText = (file: string, text: string) => {
    setFiles((current) => ({ ...current, [file]: text }));
  };

  /**
   * Write one message source's declaration into the manifest.
   *
   * The same manifest buffer the prose slots write to, saved by the same one
   * package save: a package is a file map and a revision, so a source is not a
   * second thing to save.
   */
  const setSteeringSource = (source: string, declaration: SteeringSourceDeclaration) => {
    if (parseError !== undefined) return;
    const nextManifest = writeSteeringSource(parseRecipeManifest(manifestText), 'prompts', source, declaration);
    const rendered = renderManifest(nextManifest);
    setFiles((current) => ({ ...current, [RECIPE_MANIFEST]: rendered }));
    setReformatNeeded(manifestWouldReformat(manifestText, rendered));
  };

  return (
    <div className="min-w-0 space-y-5" data-recipe-author={detail.summary.installation_id}>
      <header className="space-y-1">
        <h3 className="font-display text-[28px] leading-9 tracking-tight text-ink" data-recipe-author-name>
          {detail.summary.name}
        </h3>
        <p className="font-mono text-[11.5px] text-ink-faint">
          {detail.summary.version} · {recipeRevisionShort(detail.resolved.revision)}
        </p>
        <p className="text-[12px] leading-5 text-ink-faint" data-recipe-author-status>
          {detail.editable ? t('st.recipe.localPackage') : t('st.recipe.packageReadOnly')}
          {declaration?.extends?.source === undefined ? null : ` · ${t('st.recipe.basedOn', { source: declaration.extends.source })}`}
        </p>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-hairline" role="tablist" data-recipe-author-tabs>
        {([
          ['prompt', 'st.recipe.authorTabPrompt'],
          ['source', 'st.recipe.authorTabSource'],
        ] as const).map(([value, key]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} data-recipe-author-tab={value}
            className={`-mb-px border-b-2 px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${tab === value ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'}`}
            onClick={() => { setTab(value); }}>
            {t(key)}
          </button>
        ))}
      </div>

      {tab === 'prompt' ? (
        <div className="min-w-0 space-y-5" data-recipe-author-prompt>
          {parseError !== undefined ? (
            <div className="space-y-2 rounded-md bg-danger/5 px-3 py-2" data-recipe-manifest-error>
              <p role="alert" className="text-[12px] leading-5 text-danger">{t('st.recipe.manifestInvalid', { detail: parseError })}</p>
              <button type="button" className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                data-recipe-goto-source
                onClick={() => { setTab('source'); }}>
                {t('st.recipe.fixInSource')}
              </button>
            </div>
          ) : (
            <>
              {PROSE_SLOTS.map(({ slot, label }) => (
                <ProseSlot
                  key={slot}
                  slot={slot}
                  label={t(label)}
                  declaration={declaration}
                  files={files}
                  onInline={(text) => { setSlot('prompts', slot, { kind: 'inline', text }); }}
                  onSegments={(parts) => { setSlot('prompts', slot, { kind: 'segments', parts }); }}
                  onFile={(file, text) => { setFileText(file, text); }}
                />
              ))}
              {/*
                The sources a package speaks for. Collapsed by default for the
                same reason they are on the model page: a package that governs
                only what its owner types has nothing to say about the other
                nine, and an open list of them would bury the prompt slots.

                A source's prose is a slot like any other, so it writes through
                the same three paths: inline text and a segment array go into
                the manifest, and a file reference writes that file's own buffer
                and leaves every other byte of the manifest alone.
              */}
              <SteerSourceSection
                declaration={declaration}
                files={files}
                onChange={setSteeringSource}
                onInline={(source, text) => {
                  const current = declaration?.prompts?.steering_sources?.[source];
                  setSteeringSource(source, { ...current, mode: 'custom', steering: { kind: 'inline', text } });
                }}
                onSegments={(source, parts) => {
                  const current = declaration?.prompts?.steering_sources?.[source];
                  setSteeringSource(source, { ...current, mode: 'custom', steering: { kind: 'segments', parts } });
                }}
                onFile={(source, file, text) => {
                  // Body text and the declaration that points at it are two
                  // separate writes. Editing a Markdown file writes that file's
                  // buffer and nothing else: re-serializing the manifest to
                  // record an unchanged reference would reorder it, drop its
                  // comments and clear the reformat notice, for a change that
                  // never touched the manifest.
                  if (text !== undefined) {
                    setFileText(file, text);
                    return;
                  }
                  const current = declaration?.prompts?.steering_sources?.[source];
                  setSteeringSource(source, { ...current, mode: 'custom', steering: { kind: 'file', file } });
                }}
                onOff={(source) => {
                  // The source's mode is untouched: a custom source with its
                  // prose switched off is a different fact from a source that
                  // is switched off, and collapsing them would lose which one
                  // the author meant.
                  const current = declaration?.prompts?.steering_sources?.[source];
                  setSteeringSource(source, { ...current, mode: 'custom', steering: { kind: 'off' } });
                }}
              />
            </>
          )}
        </div>
      ) : (
        <div className="min-w-0 space-y-2" data-recipe-author-source>
          {/*
            What the package declared about its scripts, read out of the manifest
            that is open right below it. This is a reading of the declaration,
            not a form: an author writes and edits hooks as TOML, next to their
            resource files, through the same editor that has always been here.
            A `root` is shown as typed and never rewritten — it decides which
            bytes the command runs against.
          */}
          {declaration?.hooks === undefined ? null : (
            <RecipeHookDeclarations hooks={declaration.hooks} />
          )}
          {/*
            The manifest is the same buffer seen as text. Editing it here is the
            escape hatch for a shape the prose editor does not model; the prose
            tab and this view write the same files.
          */}
          <CodeEditor
            path={`${detail.summary.manifest_id}/${RECIPE_MANIFEST}`}
            value={manifestText}
            generation={generation}
            readOnly={false}
            ariaLabel={RECIPE_MANIFEST}
            onChange={(text) => { setFiles((current) => ({ ...current, [RECIPE_MANIFEST]: text })); setReformatNeeded(false); }}
          />
          {referencedFiles(declaration ?? { prompts: {} }).map((file) => (
            <div key={file} className="space-y-1" data-recipe-author-file={file}>
              <p className="font-mono text-[11.5px] text-ink-faint">{file}</p>
              <textarea rows={6} spellCheck={false} aria-label={file}
                className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
                value={files[file] ?? ''}
                onChange={(event) => { setFileText(file, event.target.value); }} />
            </div>
          ))}
          {manifestProblem !== null && parseError === undefined
            ? <p className="text-[11.5px] text-ink-faint">{manifestProblem}</p>
            : null}
        </div>
      )}

      {reformatNeeded ? (
        <div className="space-y-1.5 rounded-md bg-ink/[0.03] px-3 py-2" data-recipe-reformat-notice>
          <p className="text-[12px] leading-5 text-ink-soft">{t('st.recipe.reformatNotice')}</p>
        </div>
      ) : null}

      {detail.used_by.length === 0 ? null : (
        <p className="text-[12px] leading-5 text-ink-soft" data-recipe-author-used-by>
          {t('st.recipe.savedForModels', { models: detail.used_by.join(', ') })}
        </p>
      )}

      <FeedbackLine feedback={feedback} />
      {failure !== null ? <p role="alert" className="text-[12px] leading-5 text-danger" data-recipe-author-failure>{failure}</p> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        {/*
          One primary action, and it is the package. "Apply to model" is not
          here on purpose: saving a recipe and binding a model are two different
          decisions, and a page that quietly did both would make a package edit
          look like a model edit.
        */}
        <button type="button" disabled={!dirty || saveDisabled || parseError !== undefined}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint"
          data-recipe-save-package
          onClick={() => {
            setFailure(null);
            save.mutate({ installation_id: detail.summary.installation_id, expected_revision: detail.summary.revision, files: { ...files } });
          }}>
          {t(writing ? 'common.saving' : 'st.recipe.savePackage')}
        </button>
        <button type="button"
          className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          data-recipe-author-back
          onClick={leave}>
          {t('st.recipe.back')}
        </button>
        {dirty ? <span className="text-[12px] text-ink-faint">{t('st.draft.unsaved')}</span> : null}
      </div>
      {/*
        The write landed and this view could not catch up. The only thing left to
        do is read it again, so the only thing offered is reading it again —
        never a second Save, which would carry the revision this one replaced.
      */}
      {unreadSave === null ? null : (
        <div className="flex flex-wrap items-center gap-2" data-recipe-author-readback>
          <p className="text-[12px] leading-5 text-ink-soft" role="status">
            {t('st.recipeHook.savedReadbackFailed')}
            {reloadReason === null ? '' : ` ${t('st.recipeHook.reloadSavedFailed', { detail: reloadReason })}`}
          </p>
          <button type="button"
            disabled={readSaved.isPending}
            className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            data-recipe-reload-saved
            onClick={() => { void readSaved.mutate(unreadSave); }}>
            {t('st.recipeHook.retryLoadSaved')}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmingLeave}
        overlayId={`recipe-author-discard:${detail.summary.installation_id}`}
        title={t('st.dirty.leaveTitle')}
        body={t('st.dirty.leaveBody')}
        confirmLabel={t('st.dirty.leaveConfirm')}
        cancelLabel={t('st.dirty.stay')}
        onConfirm={() => { setConfirmingLeave(false); onBack(); }}
        onCancel={() => { setConfirmingLeave(false); }}
      />
      {/*
        The refused save comes back here rather than into a new page. The draft
        stays in `files` while the question is open, so declining returns the
        person to the exact text they were editing — with the package still at
        the revision it was at, and the change still unsaved.
      */}
      <ConfirmDialog
        open={consentPreview !== null}
        stacked
        overlayId="recipe-author-hook-scripts"
        title={t('st.recipeHook.consentTitle')}
        confirmLabel={t('st.recipe.savePackage')}
        cancelLabel={t('st.dirty.stay')}
        tone="default"
        busy={installWithConsent.isPending}
        onCancel={() => { setConsentPreview(null); }}
        onConfirm={() => {
          const candidate = consentPreview;
          if (candidate !== null) installWithConsent.mutate({ preview: candidate });
        }}>
        {consentPreview?.hooks === undefined
          ? null
          : (
            <RecipeHookConsentBody
              hooks={consentPreview.hooks}
              name={consentPreview.summary.name}
            />
          )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * The hook declarations as this package's own manifest spells them.
 *
 * Reading, not editing: the command line below is the same text as in the TOML
 * one paragraph down, and a second editable control for it would be two inputs
 * for one value. What this adds is the part an author cannot see in a flat TOML
 * list — which directory each command's files are read from — because a wrong
 * `root` is the failure that looks like the script simply not running.
 */
function RecipeHookDeclarations({ hooks }: { hooks: NonNullable<RecipeDeclarationView['hooks']> }) {
  const { t } = useI18n();
  if (hooks === 'off') {
    return (
      <p className="text-[12px] leading-5 text-ink-faint" data-recipe-author-hooks="off">{t('st.recipeHook.dropped')}</p>
    );
  }
  if (hooks.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-md bg-ink/[0.03] px-3 py-2" data-recipe-author-hooks>
      <p className="text-[11.5px] font-medium text-ink-soft">{t('st.recipeHook.declared')}</p>
      <ul className="space-y-1.5">
        {hooks.map((hook, index) => (
          <li key={index} className="space-y-0.5" data-recipe-author-hook={index}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[12px] text-ink-soft">
                {hook.event === undefined || recipeHookEventKey(hook.event) === undefined
                  ? (hook.event ?? t('st.recipeHook.eventUndeclared'))
                  : t(recipeHookEventKey(hook.event)!)}
              </span>
              <span className="font-mono text-[11px] text-ink-faint" data-recipe-author-hook-root>
                {hook.root === undefined ? t('st.recipeHook.rootDefault') : t('st.recipeHook.root', { root: hook.root })}
              </span>
            </div>
            <code className="block overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-ink">{hook.command ?? ''}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One prose slot, edited where its content actually lives.
 *
 * An inline declaration edits its own text. A file declaration edits that
 * file's buffer and leaves the manifest untouched, so a change to the prose
 * never reformats the TOML around it. A slot the package inherits from its
 * parent is shown as inherited text with an explicit action to start writing
 * here, because editing inherited text by saving it back is how a child package
 * quietly stops tracking its parent.
 */
/**
 * The message sources a package speaks for.
 *
 * Same nine rows as the model page and the same three answers, because it is
 * the same decision: a package can leave a source off, defer to whatever the
 * user's own setting says, or carry its own words. The prose takes the same
 * choices every other slot here has — inline text, or a file the package owns —
 * so an author does not learn a second way to write words.
 *
 * What a package deliberately has no second copy of is the user's own words.
 * `inherit` here means the model decides at resolve time, and showing the
 * current value would present a frozen duplicate as though the package had
 * declared it.
 */
function SteerSourceSection({ declaration, files, onChange, onInline, onSegments, onFile, onOff }: {
  declaration: RecipeDeclarationView | undefined;
  files: Readonly<Record<string, string>>;
  onChange: (source: string, declaration: SteeringSourceDeclaration) => void;
  onInline: (source: string, text: string) => void;
  onSegments: (source: string, parts: readonly SegmentDeclaration[]) => void;
  /** `text` is present when the file's own buffer is being edited. */
  onFile: (source: string, file: string, text?: string) => void;
  onOff: (source: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const declared = declaration?.prompts?.steering_sources ?? {};

  return (
    <section className="space-y-2 border-t border-hairline pt-4" data-recipe-steer-sources>
      <button type="button" aria-expanded={open} onClick={() => { setOpen(!open); }}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1 text-left outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-selected-ink/40">
        <Chevron open={open} className="text-ink-soft" />
        <span className="text-[12px] font-medium text-ink-soft">{t('st.recipe.steerSources')}</span>
        {!open && Object.keys(declared).length > 0 ? (
          <span className="truncate text-[12px] text-ink-faint">
            {t('st.recipe.steerSourcesCount', { count: String(Object.keys(declared).length) })}
          </span>
        ) : null}
      </button>
      {open ? (
        <>
          <p className="text-[12px] leading-5 text-ink-soft" data-recipe-steer-hint>{t('st.recipe.steerSourcesHint')}</p>
          <ul className="divide-y divide-hairline">
            {STEER_SOURCES.map((source) => (
              <li key={source} data-recipe-steer-source={source} className="py-2 first:pt-1">
                <SteerSourceRow
                  source={source}
                  declaration={declared[source]}
                  files={files}
                  onMode={(mode) => { onChange(source, { ...declared[source], mode }); }}
                  onInline={(text) => { onInline(source, text); }}
                  onSegments={(parts) => { onSegments(source, parts); }}
                  onFile={(file, text) => { onFile(source, file, text); }}
                  onOff={() => { onOff(source); }}
                />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** The picker's current entry for a declared shape, `off` included. */
function steerShapeValue(steering: SlotDeclaration | undefined): 'inline' | 'file' | 'segments' | 'off' {
  if (steering === undefined) return 'inline';
  return steering.kind === 'segments' ? 'segments' : steering.kind;
}

/** Which shape a source's words are stored in, in the author's own words. */
function steerShapeLabel(t: (key: I18nKey, params?: Record<string, string>) => string, steering: SlotDeclaration | undefined): string {
  if (steering === undefined) return t('st.recipe.inheritsSlot');
  if (steering.kind === 'file') return t('st.recipe.fileKind');
  if (steering.kind === 'off') return t('st.recipe.slotOffKind');
  if (steering.kind === 'segments') return t('st.recipe.segmentCount', { count: String(steering.parts.length) });
  return t('st.recipe.inlineKind');
}

const RECIPE_SOURCE_MODE_CHOICES = ['off', 'inherit', 'custom'] as const;

/**
 * One source's three answers, and its own words when it has any.
 *
 * The prose is rendered from the shape the manifest actually declares, the same
 * way `ProseSlot` renders a prompt slot: a file reference edits that file's own
 * buffer and leaves the reference alone, inline text edits its own text, and a
 * segment array edits one segment at a time without collapsing into a string.
 *
 * That is the whole point of doing it this way. A row that always opened an
 * empty inline box would let one keystroke replace a package's file reference
 * or its three-part segment list with plain text — a silent, lossy rewrite of
 * something the author wrote on purpose. Changing the shape is therefore an
 * explicit choice with a name, not a side effect of typing.
 */
function SteerSourceRow({ source, declaration, files, onMode, onInline, onSegments, onFile, onOff }: {
  source: ModelSteeringSource;
  declaration: SteeringSourceDeclaration | undefined;
  files: Readonly<Record<string, string>>;
  onMode: (mode: SteeringSourceDeclaration['mode']) => void;
  onInline: (text: string) => void;
  onSegments: (parts: readonly SegmentDeclaration[]) => void;
  onFile: (file: string, text?: string) => void;
  onOff: () => void;
}) {
  const { t } = useI18n();
  const mode = declaration?.mode ?? 'off';
  const steering = declaration?.steering;
  const label = t(`st.steerSource.${source}` as I18nKey);

  /**
   * A switch between the shapes, each naming what it would do.
   *
   * It is always visible rather than hidden behind a one-way toggle: the only
   * way back to a file reference otherwise is the raw manifest view, and a
   * person who cannot see that their stored shape was replaced has no way to
   * undo it from here.
   */
  const shapeChoice = () => (
    <label className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-soft">
      <span className="text-ink-faint">{t('st.recipe.slotFrom')}</span>
      <SettingsSelect
        id={`recipe-steer-shape-${source}`}
        ariaLabel={t('st.recipe.slotFrom')}
        dataAttr="data-recipe-steer-shape"
        value={steerShapeValue(steering)}
        choices={[
          { value: 'inline', label: t('st.recipe.inlineKind') },
          { value: 'file', label: t('st.recipe.fileKind') },
          { value: 'segments', label: t('st.recipe.segmentCount', { count: '2' }) },
          { value: 'off', label: t('st.recipe.slotOffKind') },
        ]}
        onChange={(value) => {
          if (value === 'file') onFile('');
          else if (value === 'segments') onSegments([{ kind: 'inline', text: '' }, { kind: 'inline', text: '' }]);
          else if (value === 'off') onOff();
          else onInline('');
        }}
      />
    </label>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="text-[13px] leading-5 text-ink" data-recipe-steer-label={source}>{label}</span>
        <SettingsSegmented<SteeringSourceDeclaration['mode']>
          ariaLabel={t('st.steerSource.modeAria', { source: label })}
          value={mode}
          dataAttr="data-recipe-steer-mode"
          onChange={onMode}
          choices={RECIPE_SOURCE_MODE_CHOICES.map((value) => ({ value, label: t(RECIPE_SOURCE_MODE_LABEL[value]) }))}
        />
      </div>
      {mode !== 'custom' ? null : (
        <div className="space-y-2" data-recipe-steer-editor={source}>
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <span className="text-[12px] font-medium text-ink-soft" data-recipe-steer-shape-kind={source}>
              {steerShapeLabel(t, steering)}
            </span>
            {shapeChoice()}
          </div>

          {/*
            A source whose prose is switched off inside a custom declaration is
            a real state the manifest can hold, and it is not the same as the
            row's own `off` mode: the source is still set separately, it just
            carries no words. It is shown as what it is, with the way back, the
            same way a prompt slot that is off is shown here.
          */}
          {steering?.kind === 'off' ? (
            <div className="space-y-2" data-recipe-steer-prose-off={source}>
              <p className="text-[12px] leading-5 text-ink-soft">{t('st.recipe.steerSourceProseOff')}</p>
              <button type="button"
                className="w-fit text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                data-recipe-steer-restore={source}
                onClick={() => { onInline(''); }}>
                {t('st.recipe.steerSourceRestore')}
              </button>
            </div>
          ) : steering?.kind === 'file' ? (
            <div className="space-y-1.5">
              <label className="block space-y-1">
                <span className="font-mono text-[11px] text-ink-faint">{t('st.recipe.slotFile')}</span>
                <input
                  className={`${SMALL_INPUT} font-mono`}
                  aria-label={t('st.recipe.slotFile')}
                  data-recipe-steer-file={source}
                  value={steering.file}
                  onChange={(event) => { onFile(event.target.value); }}
                  placeholder="reminders/thread.md" />
              </label>
              {/*
                The file is the source of these words, so this edits the file's
                own buffer. Writing the manifest's reference is the only thing
                that changes, which is what makes this safe to type into.
              */}
              <textarea rows={5} spellCheck={false}
                aria-label={`${label}: ${steering.file}`}
                data-recipe-steer-file-body={source}
                className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
                value={files[steering.file] ?? ''}
                onChange={(event) => { onFile(steering.file, event.target.value); }} />
            </div>
          ) : steering?.kind === 'segments' ? (
            <div className="space-y-2.5" data-recipe-steer-segments={source}>
              {steering.parts.map((part, index) => {
                const origin = part.kind === 'file' ? part.file ?? '' : t('st.recipe.inlineKind');
                return (
                  <div key={index} className="space-y-1.5" data-recipe-steer-segment={index} data-recipe-segment-kind={part.kind}>
                    <p className="break-all font-mono text-[11px] text-ink-faint">{index + 1} · {origin}</p>
                    <textarea rows={4} spellCheck={false}
                      aria-label={`${label} ${index + 1}: ${origin}`}
                      className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
                      value={part.kind === 'file' ? files[part.file ?? ''] ?? '' : part.text ?? ''}
                      onChange={(event) => {
                        // One segment changes; the others keep their own shape,
                        // order and reference, which is the whole reason a
                        // segment array is not just a string.
                        //
                        // A file segment writes that file's buffer alone, exactly
                        // as a whole-file source does. Re-emitting the array
                        // would be a second, identical declaration write: it
                        // would rewrite the manifest for a change that only
                        // touched Markdown.
                        if (part.kind === 'file') onFile(part.file ?? '', event.target.value);
                        else onSegments(steering.parts.map((existing, position) => position === index
                          ? { ...existing, text: event.target.value } : existing));
                      }} />
                  </div>
                );
              })}
            </div>
          ) : (
            <textarea rows={5} spellCheck={false}
              aria-label={label}
              data-recipe-steer-prose={source}
              placeholder={t('st.recipe.slotProseEmpty')}
              className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
              value={steering?.kind === 'inline' ? steering.text : ''}
              onChange={(event) => { onInline(event.target.value); }} />
          )}
        </div>
      )}
    </div>
  );
}

const RECIPE_SOURCE_MODE_LABEL = {
  off: 'st.steerSource.modeOff',
  inherit: 'st.steerSource.modeInherit',
  custom: 'st.steerSource.modeCustom',
} as const satisfies Readonly<Record<SteeringSourceDeclaration['mode'], I18nKey>>;

function ProseSlot({ slot, label, declaration, files, onInline, onSegments, onFile }: {
  slot: 'system' | 'steering';
  label: string;  declaration: RecipeDeclarationView | undefined;
  files: Readonly<Record<string, string>>;
  onInline: (text: string) => void;
  onSegments: (parts: readonly SegmentDeclaration[]) => void;
  onFile: (file: string, text: string) => void;
}) {
  const { t } = useI18n();
  const declared = declaration?.prompts?.[slot];

  if (declared?.kind === 'off') {
    return (
      <div className="space-y-2" data-recipe-prose-slot={slot}>
        <h4 className="text-[13px] font-medium text-ink">{label}</h4>
        <p className="text-[12px] leading-5 text-ink-soft" data-recipe-prose-off>{t('st.recipe.slotOff')}</p>
        <button type="button"
          className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          data-recipe-prose-restore={slot}
          onClick={() => { onInline(''); }}>
          {t('st.recipe.restoreSlot')}
        </button>
      </div>
    );
  }

  if (declared?.kind === 'file') {
    return (
      <div className="space-y-1.5" data-recipe-prose-slot={slot}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h4 className="text-[13px] font-medium text-ink">{label}</h4>
          <span className="font-mono text-[11px] text-ink-faint">{declared.file}</span>
        </div>
        <textarea rows={8} spellCheck={false} aria-label={`${label}: ${declared.file}`}
          className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
          value={files[declared.file] ?? ''}
          onChange={(event) => { onFile(declared.file, event.target.value); }} />
      </div>
    );
  }

  if (declared === undefined) {
    return (
      <div className="space-y-1.5" data-recipe-prose-slot={slot}>
        <h4 className="text-[13px] font-medium text-ink">{label}</h4>
        <p className="text-[12px] leading-5 text-ink-faint" data-recipe-prose-inherited>{t('st.recipe.inheritsSlot')}</p>
        <button type="button"
          className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          data-recipe-prose-declare={slot}
          onClick={() => { onInline(''); }}>
          {t('st.recipe.declareHere')}
        </button>
      </div>
    );
  }

  if (declared.kind === 'segments') {
    return (
      <div className="space-y-3" data-recipe-prose-slot={slot}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h4 className="text-[13px] font-medium text-ink">{label}</h4>
          <span className="font-mono text-[11px] text-ink-faint" data-recipe-prose-kind={slot}>
            {t('st.recipe.segmentCount', { count: String(declared.parts.length) })}
          </span>
        </div>
        {declared.parts.map((part, index) => {
          const origin = part.kind === 'file' ? part.file ?? '' : t('st.recipe.inlineKind');
          return (
            <div key={index} className="space-y-1.5" data-recipe-prose-segment={index} data-recipe-segment-kind={part.kind}>
              <p className="break-all font-mono text-[11px] text-ink-faint">{index + 1} · {origin}</p>
              <textarea rows={4} spellCheck={false} aria-label={`${label} ${index + 1}: ${origin}`}
                className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
                value={part.kind === 'file' ? files[part.file ?? ''] ?? '' : part.text ?? ''}
                onChange={(event) => {
                  if (part.kind === 'file') onFile(part.file ?? '', event.target.value);
                  else onSegments(declared.parts.map((existing, position) => position === index
                    ? { ...existing, text: event.target.value } : existing));
                }} />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-recipe-prose-slot={slot}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h4 className="text-[13px] font-medium text-ink">{label}</h4>
        <span className="font-mono text-[11px] text-ink-faint" data-recipe-prose-kind={slot}>{t('st.recipe.inlineKind')}</span>
      </div>
      <textarea rows={8} spellCheck={false} aria-label={label}
        className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
        value={declared.text}
        onChange={(event) => { onInline(event.target.value); }} />
    </div>
  );
}

/** The short choice shown when a read-only package is customized. */
export function RecipeForkChoice({ onFork }: {
  onFork: (mode: 'copy' | 'extend') => void;
}) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 space-y-3" data-recipe-fork-choice>
      <p className="text-[12px] leading-5 text-ink-soft">{t('st.recipe.forkChoiceHint')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button"
          className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-hairline-strong"
          data-recipe-fork-copy
          onClick={() => { onFork('copy'); }}>
          {t('st.recipe.forkCopy')}
        </button>
        <button type="button"
          className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          data-recipe-fork-extend
          onClick={() => { onFork('extend'); }}>
          {t('st.recipe.forkExtend')}
        </button>
      </div>
    </div>
  );
}
