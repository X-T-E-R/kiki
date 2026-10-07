/**
 * The Recipe field on a model.
 *
 * Two objects meet here and the field keeps them apart. A Recipe package is
 * something a person reads, compares and edits; a model is something the server
 * stores a reference to. Applying or detaching requests a commit from the model
 * page, where the reference and every pending model edit share one transaction.
 * Installing or browsing a package never writes the model.
 *
 * What the field never does is edit a package on the model's behalf. A bound
 * package's prose is shown read-only here; changing it happens in the author
 * workbench and reaches the model as a new binding, not as a side effect of
 * saving a model field.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { useRecipeList, useRecipeMutation } from '../../lib/recipeQueries';
import { recipeRevisionShort } from '../../lib/recipes';
import { useConnection } from '../../state/connection';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { RecipeAuthorWorkbench, RecipeForkChoice } from './RecipeAuthorWorkbench';
import { RecipeStudio } from './RecipeStudio';

const SECONDARY = 'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

/** What the field is showing. Selection is a view, not a write. */
type RecipeView =
  | { kind: 'summary' }
  | { kind: 'studio' }
  | { kind: 'author'; installationId: string }
  | { kind: 'fork'; installationId: string };

export function ModelRecipeField({ modelId, modelName, onCommitRecipe, appliedId, disabled = false, onDraftChange }: {
  modelId: string;
  /** Named wherever a commit would otherwise be anonymous. */
  modelName: string;
  /** Commit the reference with every pending model edit through the page owner. */
  onCommitRecipe: (recipe: string | null) => Promise<void>;
  /** The bound installation, or undefined when the model has none. */
  appliedId: string | undefined;
  disabled?: boolean;
  /**
   * Whether a package is being authored with unsaved words.
   *
   * The page owns the leave decision, so the field reports rather than decides:
   * closing the model panel and leaving this editor are the same mistake.
   */
  onDraftChange?: (dirty: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<RecipeView>({ kind: 'summary' });
  const [forked, setForked] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [authorDirty, setAuthorDirty] = useState(false);
  useEffect(() => { onDraftChange?.(authorDirty); }, [authorDirty, onDraftChange]);
  const listQuery = useRecipeList();
  const installed = listQuery.data ?? [];
  const bound = installed.find((entry) => entry.installation_id === appliedId);
  // A binding whose package is missing must not read as "no Recipe": the model
  // still points at something, and silently presenting that as manual settings
  // would be a false statement about what runs.
  const dangling = appliedId !== undefined && bound === undefined && !listQuery.isPending;

  // Apply and detach are explicit commits, owned by the model page so its
  // pending fields and the reference share one revision-checked write.
  const apply = useRecipeMutation(
    (installationId: string) => onCommitRecipe(installationId),
    {
      alsoModelId: modelId,
      onSuccess: () => {
        setView({ kind: 'summary' });
        setFeedback({ tone: 'success', text: t('st.recipe.applied') });
      },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.applyFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  const restoreManual = useRecipeMutation(
    (_none: undefined) => onCommitRecipe(null),
    {
      alsoModelId: modelId,
      onSuccess: () => {
        setView({ kind: 'summary' });
        setFeedback({ tone: 'success', text: t('st.recipe.cleared') });
      },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.applyFailed', { detail: errorText(locale, error) }) });
      },
    },
  );


  if (view.kind === 'studio') {
    return (
      <RecipeStudio
        modelId={modelId}
        modelName={modelName}
        appliedId={appliedId}
        onApply={async (installationId) => { await apply.mutateAsync(installationId); }}
        onClose={() => { setView({ kind: 'summary' }); }}
        onCustomize={(installationId) => { setView({ kind: 'fork', installationId }); }}
        onShowManual={() => { restoreManual.mutate(undefined); }}
      />
    );
  }

  if (view.kind === 'author' || view.kind === 'fork') {
    return (
      <RecipeAuthorRoute
        installationId={view.installationId}
        // Saving finishes the editing the package was opened for, so it returns
        // to the model row. A fork is not a save and does not come here.
        onSaved={(nextId) => { setView({ kind: 'summary' }); setForked(nextId); setAuthorDirty(false); }}
        onBack={() => { setView({ kind: 'summary' }); setAuthorDirty(false); }}
        onDirtyChange={setAuthorDirty}
        onFeedback={setFeedback}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-3" data-model-recipe={modelId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[12px] font-medium text-ink-soft">{t('st.recipe.title')}</p>
        <span className="text-[11.5px] text-ink-faint" data-recipe-mode-label>
          {appliedId === undefined ? t('st.recipe.modeManual') : t('st.recipe.modeRecipe')}
        </span>
      </div>

      {appliedId === undefined ? (
        <p className="text-[12px] leading-5 text-ink-soft" data-recipe-state-manual>
          {t('st.recipe.manualNotice')}
        </p>
      ) : dangling ? (
        <p role="alert" className="text-[12px] leading-5 text-amber-ink" data-recipe-state-dangling>
          {t('st.recipe.dangling')}
        </p>
      ) : bound === undefined ? null : (
        <div className="space-y-1" data-recipe-state-bound>
          {/* The package name is the headline, not its TOML path. */}
          <p className="font-display text-[18px] leading-7 text-ink" data-recipe-bound-name>{bound.name}</p>
          <p className="font-mono text-[11.5px] text-ink-faint" data-recipe-bound-version>
            {bound.version} · {recipeRevisionShort(bound.revision)} ·{' '}
            {bound.update_mode === 'follow' ? t('st.recipe.modeFollow') : t('st.recipe.modePinned')}
          </p>
          {bound.description === undefined ? null : (
            <p className="text-[12px] leading-5 text-ink-soft">{bound.description}</p>
          )}
          {bound.update_available === true ? (
            <p className="text-[12px] leading-5 text-ink-soft" data-recipe-update-available>
              {t('st.recipe.updateForNewBinding')}
            </p>
          ) : null}
          {bound.last_error !== undefined ? (
            <p className="text-[12px] leading-5 text-amber-ink" data-recipe-update-error>
              {t('st.recipe.updateFailedStillUsing', { version: bound.version, reason: bound.last_error.message })}
            </p>
          ) : null}
        </div>
      )}

      {appliedId === undefined ? null : (
        <>
          {/* Stated once, in the model's terms, and never repeated per field. */}
          <div className="space-y-1" data-recipe-ignored>
            <p className="text-[12px] leading-5 text-ink-soft">{t('st.recipe.keptNotice')}</p>
            <Hint>{t('st.recipe.keptDetail')}</Hint>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={SECONDARY} disabled={disabled || apply.isPending}
          data-recipe-open-studio
          onClick={() => { setFeedback(null); setView({ kind: 'studio' }); }}>
          {t(appliedId === undefined ? 'st.recipe.choose' : 'st.recipe.changeRecipe')}
        </button>
        {appliedId === undefined ? null : (
          <>
            <button type="button" className={SECONDARY} disabled={disabled}
              data-recipe-open-package
              onClick={() => { setFeedback(null); setView({ kind: 'author', installationId: appliedId }); }}>
              {t('st.recipe.viewRecipe')}
            </button>
            <button type="button" className={SECONDARY} disabled={disabled || restoreManual.isPending}
              data-recipe-restore
              onClick={() => { restoreManual.mutate(undefined); }}>
              {t('st.recipe.restoreManual')}
            </button>
          </>
        )}
      </div>

      <FeedbackLine feedback={feedback} />
      {forked === null ? null : (
        <p className="text-[12px] leading-5 text-ink-soft" data-recipe-fork-note>{t('st.recipe.forkNotBound')}</p>
      )}
    </div>
  );
}

/**
 * The route into a package: read it, or fork it when it is read-only.
 *
 * A fork is a separate write from a bind. When it succeeds the workbench opens
 * on the new package and nothing is applied to the model — the author decides
 * what the package says first, and binding stays an explicit later act.
 */
function RecipeAuthorRoute({ installationId, onSaved, onBack, onDirtyChange, onFeedback }: {
  installationId: string;
  /** The package was saved; the editing it was opened for is finished. */
  onSaved: (installationId: string) => void;
  onBack: () => void;
  /** Words typed into the package and not yet saved. */
  onDirtyChange: (dirty: boolean) => void;
  onFeedback: (feedback: Feedback) => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  // Once a fork exists the route edits that package, so the source id it came
  // from stops being what this screen is about.
  const [forkedId, setForkedId] = useState<string | null>(null);
  const editingId = forkedId ?? installationId;
  const query = useRecipeDetailQuery(editingId);
  const forkError = (error: unknown) => {
    onFeedback({ tone: 'error', text: t('st.recipe.forkFailed', { detail: errorText(locale, error) }) });
  };

  const fork = useRecipeMutation(
    (mode: 'copy' | 'extend') => client.forkRecipe({
      installation_id: installationId,
      mode,
      id: `${query.data?.summary.manifest_id ?? 'recipe'}-local`,
      name: `${query.data?.summary.name ?? 'Recipe'} (${mode})`,
    }),
    {
      onSuccess: (created) => {
        // Stay on the new package: a fork exists to be edited, and the person
        // has not asked to bind it. Nothing is written to the model here.
        setForkedId(created.summary.installation_id);
      },
      onError: forkError,
    },
  );

  if (query.data === undefined) {
    return (
      <div className="min-w-0 space-y-3" data-recipe-author-route={installationId}>
        <p role="status" className="text-[12px] text-ink-faint">
          {t(query.isError ? 'st.recipe.loadFailedShort' : 'st.recipe.loading')}
        </p>
        <button type="button" className={SECONDARY} onClick={onBack}>{t('st.recipe.back')}</button>
      </div>
    );
  }

  const detail = query.data;

  if (!detail.editable && forkedId === null) {
    return (
      <div className="min-w-0 space-y-4" data-recipe-author-route={installationId}>
        <RecipeForkChoice onFork={(mode) => { fork.mutate(mode); }} />
        <button type="button" className={SECONDARY} onClick={onBack}>{t('st.recipe.back')}</button>
      </div>
    );
  }

  return (
    <RecipeAuthorWorkbench
      detail={detail}
      onApplied={(saved) => { onSaved(saved.summary.installation_id); }}
      onBack={onBack}
      onDirtyChange={onDirtyChange}
    />
  );
}

function useRecipeDetailQuery(installationId: string) {
  const { client } = useConnection();
  return useQuery({
    queryKey: ['recipe', installationId],
    queryFn: () => client.getRecipe(installationId),
    retry: false,
  });
}
