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

import { useEffect, useState } from 'react';

import { ConfirmDialog } from '../ConfirmDialog';
import { useDirtyGuard, useDirtyReporter } from '../dirtyGuard';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import {
  RECIPE_MANIFEST, RecipeManifestError, manifestWouldReformat, parseRecipeManifest,
  readDeclaration, referencedFiles, renderManifest, writeSlot, type RecipeDeclarationView,
  type SlotDeclaration,
} from '../../lib/recipeFiles';
import { recipeRevisionShort, type RecipeDetail } from '../../lib/recipes';
import { useRecipeMutation } from '../../lib/recipeQueries';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { CodeEditor } from '../CodeEditor';
import { SMALL_INPUT } from '../ui';

type AuthorTab = 'prompt' | 'source';

/** The slots an author edits as prose, in the order they reach the model. */
const PROSE_SLOTS = [
  { slot: 'system', label: 'st.recipe.slot.system' },
  { slot: 'steering', label: 'st.recipe.slot.steering' },
] as const;

export function RecipeAuthorWorkbench({ detail, onApplied, onBack, onDirtyChange }: {
  detail: RecipeDetail;
  /** The new installation after a fork, or the saved one after a save. */
  onApplied: (next: RecipeDetail) => void;
  onBack: () => void;
  /** Words typed into the package and not yet saved. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  // The returned detail is the editor's source of truth after any write: its
  // revision and files are what the next save must carry, and a stale cache
  // would make the next save fail against a revision that no longer exists.
  const [files, setFiles] = useState<Record<string, string>>(() => ({ ...detail.files }));
  const [baselineFiles, setBaselineFiles] = useState<Record<string, string>>(() => ({ ...detail.files }));
  // Bumped only when the editor's content is replaced from outside — the first
  // load and each accepted save. Typing must not change it, or the editor would
  // be rebuilt on every keystroke and lose the caret and undo history.
  const [generation, setGeneration] = useState(0);
  const [tab, setTab] = useState<AuthorTab>('prompt');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [manifestProblem, setManifestProblem] = useState<string | null>(null);
  const [reformatNeeded, setReformatNeeded] = useState(false);

  const manifestText = files[RECIPE_MANIFEST] ?? '';
  const dirty = JSON.stringify(files) !== JSON.stringify(baselineFiles);
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

  const save = useRecipeMutation(
    (input: { installation_id: string; expected_revision: string; files: Record<string, string> }) => client.saveLocalRecipe(input),
    {
      onSuccess: (saved) => {
        setFiles({ ...saved.files });
        setBaselineFiles({ ...saved.files });
        // The editor's content was replaced from outside, so this is exactly the
        // case `generation` exists for.
        setGeneration((current) => current + 1);
        setFeedback({ tone: 'success', text: t('st.recipe.savedNewBinding') });
        onApplied(saved);
      },
      onError: (error) => { setFeedback({ tone: 'error', text: t('st.recipe.saveFailed', { detail: errorText(locale, error) }) }); },
    },
  );

  /** Write one slot's prose back into the manifest and into any file it owns. */
  const setSlot = (group: 'prompts' | 'main' | 'independent', slot: 'system' | 'steering', value: SlotDeclaration) => {
    if (parseError !== undefined) return;
    const nextManifest = writeSlot(parseRecipeManifest(manifestText), group, slot, value);
    const rendered = renderManifest(nextManifest);
    setFiles((current) => ({ ...current, [RECIPE_MANIFEST]: rendered }));
    setReformatNeeded(manifestWouldReformat(manifestText, rendered));
  };

  /** Write a referenced Markdown file, which is a buffer of its own. */
  const setFileText = (file: string, text: string) => {
    setFiles((current) => ({ ...current, [file]: text }));
    setReformatNeeded(false);
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
              <Hint>{t('st.recipe.proseFirstHint')}</Hint>
              {PROSE_SLOTS.map(({ slot, label }) => (
                <ProseSlot
                  key={slot}
                  slot={slot}
                  label={t(label)}
                  declaration={declaration}
                  files={files}
                  onInline={(text) => { setSlot('prompts', slot, { kind: 'inline', text }); }}
                  onFile={(file, text) => { setFileText(file, text); }}
                />
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="min-w-0 space-y-2" data-recipe-author-source>
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

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        {/*
          One primary action, and it is the package. "Apply to model" is not
          here on purpose: saving a recipe and binding a model are two different
          decisions, and a page that quietly did both would make a package edit
          look like a model edit.
        */}
        <button type="button" disabled={!dirty || save.isPending || parseError !== undefined}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint"
          data-recipe-save-package
          onClick={() => {
            save.mutate({ installation_id: detail.summary.installation_id, expected_revision: detail.summary.revision, files });
          }}>
          {t(save.isPending ? 'common.saving' : 'st.recipe.savePackage')}
        </button>
        <button type="button"
          className="rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink"
          data-recipe-author-back
          onClick={leave}>
          {t('st.recipe.back')}
        </button>
        {dirty ? <span className="text-[12px] text-ink-faint">{t('st.draft.unsaved')}</span> : null}
      </div>
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
function ProseSlot({ slot, label, declaration, files, onInline, onFile }: {
  slot: 'system' | 'steering';
  label: string;
  declaration: RecipeDeclarationView | undefined;
  files: Readonly<Record<string, string>>;
  onInline: (text: string) => void;
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

  const text = declared.kind === 'inline' ? declared.text
    : declared.kind === 'segments' ? declared.parts.map((part) => part.text ?? '').join('\n\n')
      : '';

  return (
    <div className="space-y-1.5" data-recipe-prose-slot={slot}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h4 className="text-[13px] font-medium text-ink">{label}</h4>
        <span className="font-mono text-[11px] text-ink-faint" data-recipe-prose-kind={slot}>
          {declared.kind === 'segments' ? t('st.recipe.segmentCount', { count: String(declared.parts.length) }) : t('st.recipe.inlineKind')}
        </span>
      </div>
      <textarea rows={8} spellCheck={false} aria-label={label}
        className={`${SMALL_INPUT} h-auto w-full resize-y font-mono text-[12px] leading-5`}
        value={text}
        onChange={(event) => {
          // A segment list keeps its shape: editing the joined text rewrites the
          // inline segments and leaves a file segment as a reference, rather
          // than collapsing the group into one string.
          onInline(event.target.value);
        }} />
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
