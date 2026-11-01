/**
 * The Recipe library — the package's own home in settings.
 *
 * What this page is for is the same rule the model Recipe field enforces from
 * the other side: a Recipe is a package a person installs, reads and edits,
 * and a model's reference to one is a separate decision made on the model.
 * Nothing on this page writes a model. The only model-facing write here is
 * the remove flow's explicit "also detach the models that use it" choice, and
 * even that is stated in the confirmation rather than implied.
 *
 * The page has three depths, addressed through `?recipe=` and `?view=edit` so
 * a copied link, a refresh and Back all land on the same package:
 * the library list, one package read out loud, and the author workbench.
 * Editing never binds; saving a package only changes what a *new* binding
 * would use, which is exactly what the save confirmation says.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { errorText } from '@kiki/session-core/i18n';
import type { RecipeMarket, RecipeSummary } from '@kiki/protocol';
import { recipeSettingsPath } from '@kiki/session-core/settings';

import { useI18n } from '../../i18n';
import {
  useRecipeDetail, useRecipeList, useRecipeMarkets, useRecipeMutation,
} from '../../lib/recipeQueries';
import {
  recipeIsSelectable, recipeRevisionShort,
} from '../../lib/recipes';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { SectionCard } from './SectionCard';
import { RecipeAuthorWorkbench, RecipeForkChoice } from './RecipeAuthorWorkbench';
import { RecipeDetailBody } from './RecipeDetailBody';
import { RecipeImportForm } from './RecipeImportForm';
import { SMALL_INPUT } from '../ui';

const SECONDARY = 'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export function RecipesSection({ recipeId, initialEdit = false }: {
  /** The package the query names, or null on the library list. */
  recipeId: string | null;
  /** `?view=edit`: open the author workbench without a read stop first. */
  initialEdit?: boolean;
}) {
  const navigate = useNavigate();
  const openLibrary = () => { void navigate(recipeSettingsPath()); };
  if (recipeId === null) return <RecipeLibrary onOpen={(id) => { void navigate(recipeSettingsPath(id)); }} />;
  return (
    <RecipePackagePage
      installationId={recipeId}
      initialEdit={initialEdit}
      onOpenLibrary={openLibrary}
      onEdit={(id) => { void navigate(recipeSettingsPath(id, 'edit')); }}
      onForked={(id) => { void navigate(recipeSettingsPath(id, 'edit'), { replace: true }); }}
      onRemoved={openLibrary}
    />
  );
}

/**
 * The installed list, with the three maintenance facts a model row never had
 * room for: who uses a package, whether its source offers something newer, and
 * the update rule it follows. Every write here names the package it touches.
 */
function RecipeLibrary({ onOpen }: { onOpen: (installationId: string) => void }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const listQuery = useRecipeList();
  const installed = listQuery.data ?? [];
  const [feedback, setFeedback] = useState<Feedback>(null);

  const checkUpdates = useRecipeMutation(
    () => client.checkRecipeUpdates(),
    {
      onSuccess: (checked) => {
        const updates = checked.filter((entry) => entry.update_available === true).length;
        setFeedback({ tone: 'success', text: t('st.recipes.checked', { count: checked.length, updates }) });
      },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.updateFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  const setMode = useRecipeMutation(
    (input: { summary: RecipeSummary; mode: 'follow' | 'pinned' }) => client.updateRecipe({
      installation_id: input.summary.installation_id,
      expected_revision: input.summary.revision,
      update_mode: input.mode,
    }),
    {
      onSuccess: () => { setFeedback({ tone: 'success', text: t('st.recipe.updatedShort') }); },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.updateFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  const applyUpdate = useRecipeMutation(
    (summary: RecipeSummary) => client.updateRecipe({
      installation_id: summary.installation_id,
      expected_revision: summary.revision,
    }),
    {
      onSuccess: () => { setFeedback({ tone: 'success', text: t('st.recipe.updatedShort') }); },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.updateFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  return (
    <div className="space-y-6">
      <SectionCard id="st-card-recipes-library" title={t('st.recipes.libraryTitle')}
        actions={(
          <button type="button" className={SECONDARY} disabled={checkUpdates.isPending || listQuery.isError}
            data-recipes-check-updates
            onClick={() => { setFeedback(null); checkUpdates.mutate(undefined); }}>
            {t('st.recipes.checkUpdates')}
          </button>
        )}>
        {listQuery.isError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-[12px] leading-5 text-danger">
              {t('st.recipe.listFailed', { detail: errorText(locale, listQuery.error) })}
            </p>
            <button type="button" className={SECONDARY} disabled={listQuery.isFetching}
              data-recipes-list-retry
              onClick={() => { void listQuery.refetch(); }}>
              {t('st.recipe.retryLoad')}
            </button>
          </div>
        ) : listQuery.isPending ? (
          <p role="status" className="text-[12px] text-ink-faint">{t('st.recipe.loading')}</p>
        ) : installed.length === 0 ? (
          <p className="text-[12px] leading-5 text-ink-faint" data-recipes-empty>{t('st.recipe.noneInstalled')}</p>
        ) : (
          <ul className="divide-y divide-hairline border-y border-hairline" data-recipes-list>
            {installed.map((summary) => (
              <RecipeLibraryRow key={summary.installation_id} summary={summary}
                busy={setMode.isPending || applyUpdate.isPending}
                onOpen={onOpen}
                onSetMode={(mode) => { setFeedback(null); setMode.mutate({ summary, mode }); }}
                onUpdate={() => { setFeedback(null); applyUpdate.mutate(summary); }} />
            ))}
          </ul>
        )}
        <FeedbackLine feedback={feedback} />
      </SectionCard>

      <RecipeImportCard />
      <RecipeMarketsCard />
    </div>
  );
}

/** One installed package: open for reading, update rule, and any newer copy. */
function RecipeLibraryRow({ summary, busy, onOpen, onSetMode, onUpdate }: {
  summary: RecipeSummary;
  busy: boolean;
  onOpen: (installationId: string) => void;
  onSetMode: (mode: 'follow' | 'pinned') => void;
  onUpdate: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 py-2.5" data-recipes-row={summary.installation_id}>
      <div className="min-w-0 flex-1">
        <button type="button"
          className="block max-w-full truncate text-left text-[13px] text-ink underline decoration-ink/20 underline-offset-4 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
          data-recipes-open={summary.installation_id}
          onClick={() => { onOpen(summary.installation_id); }}>
          {summary.name}
        </button>
        <p className="truncate font-mono text-[11px] text-ink-faint">
          {summary.version} · {recipeRevisionShort(summary.revision)}
          {recipeIsSelectable(summary) ? '' : ` · ${t('st.recipe.unavailable')}`}
        </p>
        {summary.used_by !== undefined && summary.used_by.length > 0 ? (
          <p className="truncate text-[11px] text-ink-faint" data-recipes-used-by={summary.installation_id}>
            {t('st.recipes.usedBy', { models: summary.used_by.join(', ') })}
          </p>
        ) : null}
        {summary.last_error !== undefined ? (
          <p className="text-[11.5px] leading-5 text-amber-ink" data-recipes-row-error={summary.installation_id}>
            {t('st.recipe.updateFailedStillUsing', { version: summary.version, reason: summary.last_error.message })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {summary.update_available === true ? (
          <button type="button" className={SECONDARY} disabled={busy}
            data-recipes-update={summary.installation_id}
            onClick={onUpdate}>
            {t('st.recipe.update')}
          </button>
        ) : null}
        <select aria-label={t('st.recipe.updateModeAria', { name: summary.name })}
          className={`${SMALL_INPUT} w-auto`}
          data-recipes-update-mode={summary.installation_id}
          value={summary.update_mode} disabled={busy}
          onChange={(event) => { onSetMode(event.target.value === 'follow' ? 'follow' : 'pinned'); }}>
          <option value="follow">{t('st.recipe.modeFollow')}</option>
          <option value="pinned">{t('st.recipe.modePinned')}</option>
        </select>
      </div>
    </li>
  );
}

/**
 * Install from a link or path. The preview is the frozen candidate and the
 * script-hook confirmation lives inside the form — the same contract the
 * model picker's import tab follows, minus the apply step this page never has.
 */
function RecipeImportCard() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [feedback, setFeedback] = useState<Feedback>(null);
  return (
    <SectionCard id="st-card-recipe-import" title={t('st.recipes.installFrom')}>
      <RecipeImportForm
        onInstalled={(id) => { void navigate(recipeSettingsPath(id)); }}
        onFeedback={setFeedback}
      />
      <FeedbackLine feedback={feedback} />
    </SectionCard>
  );
}

/**
 * Configured markets. A market's catalog itself is browsed from a model's
 * picker, where choosing leads to installing; this card manages the sources.
 */
function RecipeMarketsCard() {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const marketsQuery = useRecipeMarkets();
  const markets = marketsQuery.data ?? [];
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const save = useRecipeMutation(
    (market: RecipeMarket) => markets.some((entry) => entry.id === market.id)
      ? client.updateRecipeMarket(market)
      : client.addRecipeMarket(market),
    {
      onSuccess: () => { setFeedback({ tone: 'success', text: t('st.recipe.marketSaved') }); },
      onError: (error) => { setFeedback({ tone: 'error', text: t('st.recipe.marketAddFailed', { detail: errorText(locale, error) }) }); },
    },
  );
  const remove = useRecipeMutation(
    (id: string) => client.removeRecipeMarket(id),
    {
      onSuccess: () => { setFeedback({ tone: 'success', text: t('st.recipe.marketSaved') }); },
      onError: (error) => { setFeedback({ tone: 'error', text: t('st.recipe.marketAddFailed', { detail: errorText(locale, error) }) }); },
    },
  );

  const add = () => {
    const trimmedUrl = url.trim();
    if (trimmedUrl === '') return;
    const id = trimmedUrl.replace(/^https?:\/\//u, '').replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/g, '').toLowerCase();
    save.mutate({
      id: id === '' ? `market-${markets.length + 1}` : id,
      name: name.trim() === '' ? trimmedUrl : name.trim(),
      url: trimmedUrl,
      enabled: true,
      offline: false,
    });
    setName('');
    setUrl('');
  };

  return (
    <SectionCard id="st-card-recipe-markets" title={t('st.recipe.market')}>
      {marketsQuery.isError ? (
        <p role="alert" className="text-[12px] leading-5 text-danger">
          {t('st.recipe.marketFailed', { detail: errorText(locale, marketsQuery.error) })}
        </p>
      ) : (
        <div className="space-y-3" data-recipe-market-manager>
          {markets.length === 0 ? (
            <p className="text-[12px] leading-5 text-ink-faint" data-recipe-no-markets>{t('st.recipe.noMarkets')}</p>
          ) : (
            <ul className="divide-y divide-hairline border-y border-hairline" data-recipe-market-rows>
              {markets.map((market) => (
                <li key={market.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 py-2" data-recipe-market-row={market.id}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">{market.name}</p>
                    <p className="truncate font-mono text-[11px] text-ink-faint">{market.url}</p>
                    {market.offline ? (
                      <p className="text-[11.5px] leading-5 text-amber-ink">{t('st.recipe.marketOffline', { name: market.name })}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[12px] text-ink-soft">
                      <input type="checkbox" checked={market.enabled} disabled={save.isPending}
                        data-recipe-market-enabled={market.id}
                        onChange={(event) => { save.mutate({ ...market, enabled: event.target.checked }); }} />
                      {t('st.recipe.marketEnabled')}
                    </label>
                    <button type="button" className={SECONDARY} disabled={remove.isPending}
                      data-recipe-market-remove={market.id}
                      onClick={() => { remove.mutate(market.id); }}>
                      {t('st.recipe.marketRemove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2" data-recipe-market-add>
            <p className="text-[12px] font-medium text-ink-soft">{t('st.recipe.marketAdd')}</p>
            <div className="flex flex-wrap gap-2">
              <input className={`${SMALL_INPUT} min-w-0 flex-1`} value={name}
                placeholder={t('st.recipe.marketName')} data-recipe-market-add-name
                onChange={(event) => { setName(event.target.value); }} />
              <input className={`${SMALL_INPUT} min-w-0 flex-[2] font-mono`} value={url}
                placeholder="https://example.com/recipes/catalog.json" data-recipe-market-add-url
                onChange={(event) => { setUrl(event.target.value); }} />
              <button type="button" className={SECONDARY} disabled={save.isPending || url.trim() === ''}
                data-recipe-market-add-submit
                onClick={add}>
                {t('st.recipe.marketAdd')}
              </button>
            </div>
            <Hint>{t('st.recipe.marketAddHint')}</Hint>
          </div>
        </div>
      )}
      <FeedbackLine feedback={feedback} />
    </SectionCard>
  );
}

/**
 * One package's own page: read, then edit. The read leads — a person arriving
 * from a model or from the list wants to know what the package says before
 * they change it — and the author workbench is one deliberate step further.
 *
 * Saving never leaves the page and never binds: the workbench keeps editing
 * the new revision it was handed back, and the model that may later use it is
 * named on the page rather than written to.
 */
function RecipePackagePage({ installationId, initialEdit, onOpenLibrary, onEdit, onForked, onRemoved }: {
  installationId: string;
  initialEdit: boolean;
  onOpenLibrary: () => void;
  onEdit: (installationId: string) => void;
  /** A fork replaces the address: the old package was left, not stacked under. */
  onForked: (installationId: string) => void;
  onRemoved: () => void;
}) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  // A read-only package forks before the workbench opens; the route then edits
  // the fork, and the address follows it so refresh keeps editing the copy.
  const [forkedId, setForkedId] = useState<string | null>(null);
  const editingId = forkedId ?? installationId;
  const detailQuery = useRecipeDetail(editingId);
  const [editing, setEditing] = useState(initialEdit);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const fork = useRecipeMutation(
    (mode: 'copy' | 'extend') => client.forkRecipe({
      installation_id: installationId,
      mode,
      id: `${detailQuery.data?.summary.manifest_id ?? 'recipe'}-local`,
      name: `${detailQuery.data?.summary.name ?? 'Recipe'} (${mode})`,
    }),
    {
      onSuccess: (created) => {
        setForkedId(created.summary.installation_id);
        onForked(created.summary.installation_id);
      },
      onError: (error) => {
        setFeedback({ tone: 'error', text: t('st.recipe.forkFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  const remove = useRecipeMutation(
    () => client.removeRecipe({
      installation_id: installationId,
      expected_revision: detailQuery.data?.summary.revision,
      // The confirmation names the models, so the detach is part of the same
      // stated decision rather than a side effect discovered afterwards.
      disable_models: true,
    }),
    {
      onSuccess: () => { setConfirmingRemove(false); onRemoved(); },
      onError: (error) => {
        setConfirmingRemove(false);
        setFeedback({ tone: 'error', text: t('st.recipe.removeFailed', { detail: errorText(locale, error) }) });
      },
    },
  );

  if (detailQuery.data === undefined) {
    return (
      <div className="space-y-3">
        <button type="button" className={SECONDARY} data-recipe-open-library onClick={onOpenLibrary}>
          {t('st.recipe.backToList')}
        </button>
        {detailQuery.isError ? (
          <div className="flex flex-wrap items-center gap-2" data-recipe-load-failed>
            <p role="alert" className="text-[12px] leading-5 text-danger">
              {t('st.recipe.loadFailed', { detail: errorText(locale, detailQuery.error) })}
            </p>
            <button type="button" className={SECONDARY} disabled={detailQuery.isFetching}
              data-recipe-load-retry
              onClick={() => { void detailQuery.refetch(); }}>
              {t('st.recipe.retryLoad')}
            </button>
          </div>
        ) : (
          <p role="status" className="text-[12px] text-ink-faint">
            {t(detailQuery.isSuccess ? 'st.recipe.conflictGone' : 'st.recipe.loading')}
          </p>
        )}
      </div>
    );
  }

  const detail = detailQuery.data;

  if (editing) {
    if (!detail.editable && forkedId === null) {
      return (
        <div className="space-y-4" data-recipe-fork-gate={installationId}>
          <button type="button" className={SECONDARY} onClick={() => { setEditing(false); }}>
            {t('st.recipe.back')}
          </button>
          <RecipeForkChoice onFork={(mode) => { fork.mutate(mode); }} />
          <FeedbackLine feedback={feedback} />
        </div>
      );
    }
    return (
      <RecipeAuthorWorkbench
        detail={detail}
        onApplied={() => { /* The workbench keeps editing the new revision; the page stays. */ }}
        onBack={() => { setEditing(false); }}
      />
    );
  }

  return (
    <div className="space-y-5" data-recipe-package-page={installationId}>
      <div>
        <button type="button" className={SECONDARY} data-recipe-open-library onClick={onOpenLibrary}>
          {t('st.recipe.backToList')}
        </button>
      </div>
      <RecipeDetailBody detail={detail} />
      {/*
        The commitment stays put while the package is read, the same rule the
        model picker's detail follows: a package can run to several screens of
        prose, and an Edit button at the end of it is a button nobody scrolls
        to.
      */}
      <div className="sticky bottom-[calc(-1*var(--settings-scroll-pb,0px))] z-10 flex flex-wrap items-center gap-2 border-t border-hairline bg-canvas/95 py-3 backdrop-blur-sm">
        <button type="button" className={SECONDARY}
          data-recipe-edit={installationId}
          onClick={() => { setEditing(true); onEdit(installationId); }}>
          {t(detail.editable ? 'st.recipe.editPackage' : 'st.recipe.customizePackage')}
        </button>
        <button type="button" className={SECONDARY}
          data-recipe-remove={installationId}
          onClick={() => { setConfirmingRemove(true); }}>
          {t('st.recipe.remove')}
        </button>
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        stacked
        overlayId="recipe-remove-confirm"
        title={t('st.recipe.removeConfirmTitle', { name: detail.summary.name })}
        body={t('st.recipe.removeConfirmBody')}
        consequences={detail.used_by.length === 0 ? undefined : [
          t('st.recipes.usedBy', { models: detail.used_by.join(', ') }),
        ]}
        confirmLabel={t('st.recipe.removeConfirmAction')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        busy={remove.isPending}
        onCancel={() => { setConfirmingRemove(false); }}
        onConfirm={() => { remove.mutate(undefined); }}
      />
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
