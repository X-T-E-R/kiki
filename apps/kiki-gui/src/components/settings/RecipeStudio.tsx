/**
 * Choosing a Recipe for a model.
 *
 * The rule this screen exists to enforce is that looking is free and choosing
 * is one deliberate commit. Selecting a row, searching, opening a market or
 * previewing a link all read; the only thing that writes is the final
 * `applyRecipe`, and it writes one model patch against one revision. That is
 * why the model draft stays clean while the picker is open, and why the button
 * names the model it is about to change.
 *
 * The second rule is that a Recipe is a whole package, not a bag of settings.
 * The list shows packages; the detail leads with what the package says and
 * provides, and keeps provenance out of the first screen.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { errorText, type Locale } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { recipeConsentField, recipePreviewNeedsConsent } from '../../lib/recipeHooks';
import { useRecipeList, useRecipeMarkets, useRecipeMutation } from '../../lib/recipeQueries';
import {
  recipeIsSelectable, recipeRevisionShort, type RecipePreview,
} from '../../lib/recipes';
import { useConnection } from '../../state/connection';
import { ConfirmDialog } from '../ConfirmDialog';
import { FeedbackLine, Hint, type Feedback } from '../controls';
import { FORM_LABEL, SettingsDetailLayout } from './SettingsPrimitives';
import { DownloadZipButton } from './DownloadZipButton';
import { RecipeDetailBody } from './RecipeDetailBody';
import { RecipeHookConsentBody, RecipeHookScripts } from './RecipeHookScripts';
import { SMALL_INPUT } from '../ui';

type PickerTab = 'installed' | 'market' | 'import';

export function RecipeStudio({
  modelId,
  modelName,
  appliedId,
  onApply,
  onClose,
  onCustomize,
  onShowManual,
}: {
  modelId: string;
  /** Named in the apply button, so the commit never looks anonymous. */
  modelName: string;
  /** What this model uses now, so the list can mark it. */
  appliedId: string | undefined;
  /** The one write this screen performs. */
  onApply: (installationId: string) => Promise<void>;
  onClose: () => void;
  /** Open the author workbench on a package. */
  onCustomize: (installationId: string) => void;
  /** Restore the model's own saved settings. */
  onShowManual: () => void;
}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<PickerTab>('installed');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrowPane, setNarrowPane] = useState<'list' | 'detail'>('list');
  const studioRef = useRef<HTMLDivElement>(null);

  /**
   * On a narrow screen the list and the detail are one column, so opening the
   * detail does not move the page: without this the person is left looking at
   * whatever the model fields above happened to be scrolled to, with no sign
   * that the package opened below them.
   *
   * `block: 'start'` is deliberately not used here: this surface already sits
   * part-way down a long editor, so aligning its top edge to the viewport puts
   * the tabs off screen. `nearest` brings it into view without moving a page
   * that is already showing it.
   */
  useEffect(() => {
    if (narrowPane !== 'detail') return;
    studioRef.current?.scrollIntoView({ block: 'nearest' });
  }, [narrowPane, selectedId]);

  /**
   * Focus follows the surface that just opened.
   *
   * Opening the studio unmounts the control that opened it, so without this the
   * caret drops to the document and the next Tab starts again from the top of
   * the page — a person using the keyboard lands above where they were working.
   */
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    studioRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (narrowPane !== 'detail') return;
    // The pane swap unmounts the row that was focused, so the caret moves with
    // it rather than being left pointing at a removed node.
    const target = detailRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], textarea:not([disabled])',
    );
    (target ?? detailRef.current)?.focus({ preventScroll: true });
  }, [narrowPane, selectedId]);

  const listQuery = useRecipeList();
  const installed = listQuery.data ?? [];
  const needle = query.trim().toLowerCase();
  // Search covers the three things that identify a package: what it is called,
  // its manifest id, and where it came from.
  const matches = needle === '' ? installed : installed.filter((summary) => {
    const haystack = `${summary.name} ${summary.manifest_id} ${summary.source.locator}`.toLowerCase();
    return haystack.includes(needle);
  });
  const selected = selectedId === null ? undefined : installed.find((entry) => entry.installation_id === selectedId);

  const detailQuery = useRecipeStudioDetail(selectedId);
  const [applyError, setApplyError] = useState<Feedback>(null);
  const [applying, setApplying] = useState(false);

  const apply = async (installationId: string) => {
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(installationId);
    } catch (error) {
      // The candidate stays where it is: a failed commit must not send the
      // reader back to the list to find what they had chosen.
      setApplyError({ tone: 'error', text: t('st.recipe.applyFailed', { detail: errorText(locale, error) }) });
    } finally {
      setApplying(false);
    }
  };

  const list = (
    <div className="min-w-0 space-y-3" data-recipe-studio-list>
      <div className="flex flex-wrap gap-1 border-b border-hairline" role="tablist" data-recipe-studio-tabs>
        {([
          ['installed', 'st.recipe.tabInstalled'],
          ['market', 'st.recipe.tabMarket'],
          ['import', 'st.recipe.tabImport'],
        ] as const).map(([value, key]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} data-recipe-studio-tab={value}
            className={`-mb-px border-b-2 px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${tab === value ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'}`}
            onClick={() => { setTab(value); }}>
            {t(key)}
          </button>
        ))}
      </div>

      {tab === 'installed' ? (
        <>
          <label className={FORM_LABEL}>
            <span className="sr-only">{t('st.recipe.search')}</span>
            <input className={`${SMALL_INPUT} w-full`} value={query} data-recipe-studio-search
              placeholder={t('st.recipe.searchPlaceholder')}
              onChange={(event) => { setQuery(event.target.value); }} />
          </label>
          {listQuery.isError ? (
            <p role="alert" className="text-[12px] leading-5 text-danger">{t('st.recipe.listFailed', { detail: errorText(locale, listQuery.error) })}</p>
          ) : matches.length === 0 ? (
            <div className="space-y-1.5">
              <p className="text-[12px] leading-5 text-ink-faint">
                {t(installed.length === 0 ? 'st.recipe.noneInstalled' : 'st.recipe.searchEmpty')}
              </p>
              {installed.length === 0 ? (
                <button type="button" className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                  data-recipe-studio-goto-import
                  onClick={() => { setTab('import'); }}>
                  {t('st.recipe.fromUrlAdd')}
                </button>
              ) : (
                <button type="button" className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40"
                  data-recipe-studio-clear-search
                  onClick={() => { setQuery(''); }}>
                  {t('st.recipe.clearSearch')}
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-hairline border-y border-hairline" data-recipe-studio-list-rows>
              {matches.map((summary) => (
                <li key={summary.installation_id}>
                  <button type="button" data-recipe-studio-row={summary.installation_id}
                    aria-current={summary.installation_id === selectedId}
                    className={`flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${summary.installation_id === selectedId ? 'bg-ink/[0.05]' : 'hover:bg-ink/[0.03]'}`}
                    onClick={() => { setSelectedId(summary.installation_id); setNarrowPane('detail'); }}>
                    <span className="flex w-full min-w-0 items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{summary.name}</span>
                      {summary.installation_id === appliedId
                        ? <span className="shrink-0 text-[11px] text-selected-ink" data-recipe-in-use>{t('st.recipe.inUse')}</span>
                        : null}
                    </span>
                    <span className="w-full truncate font-mono text-[11px] text-ink-faint">
                      {summary.version} · {recipeRevisionShort(summary.revision)}
                      {recipeIsSelectable(summary) ? '' : ` · ${t('st.recipe.unavailable')}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}

      {tab === 'market' ? <RecipeMarketList onPicked={(id) => { setSelectedId(id); setNarrowPane('detail'); }} /> : null}
      {tab === 'import' ? (
        <RecipeImportForm onInstalled={(id) => { setSelectedId(id); setNarrowPane('detail'); }} onApply={apply} />
      ) : null}
    </div>
  );

  const detail = selected === undefined ? null : (
    <div className="min-w-0 space-y-4" data-recipe-studio-detail={selected.installation_id} ref={detailRef} tabIndex={-1}>
      <button type="button" className="text-[12px] text-ink-soft underline decoration-ink/20 underline-offset-4 hover:text-ink focus-visible:ring-2 focus-visible:ring-selected-ink/40 md:hidden"
        data-recipe-studio-back
        onClick={() => { setNarrowPane('list'); }}>
        {t('st.recipe.backToList')}
      </button>
      {detailQuery.data === undefined
        ? <p role="status" className="text-[12px] text-ink-faint">{t(detailQuery.isError ? 'st.recipe.loadFailedShort' : 'st.recipe.loading')}</p>
        : (
          <>
            <RecipeDetailBody detail={detailQuery.data} />
            {/*
              The commitment stays put while the package is read. A package can
              run to several screens of prose, and an Apply button at the end of
              it is a button nobody scrolls to: the person reads "what this
              provides", decides, and then has to find where to say so.
            */}
            <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-t border-hairline bg-panel px-1 py-3">
              {selected.installation_id === appliedId ? (
                <span className="text-[12px] text-ink-soft" data-recipe-already-applied>{t('st.recipe.alreadyApplied')}</span>
              ) : (
                <button type="button" className={PRIMARY} disabled={applying || !recipeIsSelectable(selected)}
                  data-recipe-apply={selected.installation_id}
                  onClick={() => { void apply(selected.installation_id); }}>
                  {t(applying ? 'st.recipe.applying' : 'st.recipe.applyToModel', { model: modelName })}
                </button>
              )}
              <button type="button" className={SECONDARY} data-recipe-customize={selected.installation_id}
                onClick={() => { onCustomize(selected.installation_id); }}>
                {t(detailQuery.data.editable ? 'st.recipe.editPackage' : 'st.recipe.customizePackage')}
              </button>
              <button type="button" className={SECONDARY} data-recipe-restore-manual
                onClick={() => { onShowManual(); }}>
                {t('st.recipe.restoreManual')}
              </button>
              <DownloadZipButton installationId={selected.installation_id} name={selected.name} />
            </div>
            <FeedbackLine feedback={applyError} />
          </>
        )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-4" data-recipe-studio={modelId} ref={studioRef} tabIndex={-1}>
      <SettingsDetailLayout
        narrowPane={narrowPane}
        columns="md:grid-cols-[minmax(240px,0.8fr)_minmax(0,2fr)]"
        list={list}
        detail={detail ?? (
          <div className="min-w-0">
            <p className="text-[12px] leading-5 text-ink-faint">{t('st.recipe.pickHint')}</p>
          </div>
        )}
      />
      <button type="button" className={SECONDARY} data-recipe-studio-close onClick={onClose}>{t('common.close')}</button>
    </div>
  );
}

const PRIMARY = 'rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint';
const SECONDARY = 'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

/** Detail for whichever row is open, fetched but never written. */
function useRecipeStudioDetail(installationId: string | null) {
  const { client } = useConnection();
  return useQuery({
    queryKey: ['recipe', installationId ?? ''],
    queryFn: () => client.getRecipe(installationId ?? ''),
    enabled: installationId !== null && installationId !== '',
    retry: false,
  });
}

/** Markets, each with its own cached catalog and its own failure. */
function RecipeMarketList({ onPicked }: { onPicked: (installationId: string) => void }) {
  const { t, locale } = useI18n();
  const marketsQuery = useRecipeMarkets();
  const markets = marketsQuery.data ?? [];
  const [marketId, setMarketId] = useState<string | null>(null);
  const market = markets.find((entry) => entry.id === marketId) ?? markets[0];
  const [failure, setFailure] = useState<string | null>(null);
  const install = useRecipeMarketInstall(setFailure, locale, onPicked);

  if (marketsQuery.isError) {
    return <p role="alert" className="text-[12px] leading-5 text-danger">{t('st.recipe.marketFailed', { detail: errorText(locale, marketsQuery.error) })}</p>;
  }
  if (markets.length === 0) {
    return <p className="text-[12px] leading-5 text-ink-faint" data-recipe-no-markets>{t('st.recipe.noMarkets')}</p>;
  }
  return (
    <div className="min-w-0 space-y-2" data-recipe-market>
      {markets.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" data-recipe-market-tabs>
          {markets.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={market?.id === entry.id} data-recipe-market-tab={entry.id}
              className={`rounded-md px-2 py-1 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-selected-ink/40 ${market?.id === entry.id ? 'bg-ink/[0.07] text-ink' : 'text-ink-soft hover:bg-ink/[0.04]'}`}
              onClick={() => { setMarketId(entry.id); setFailure(null); }}>
              {entry.name}
            </button>
          ))}
        </div>
      ) : null}
      {/* Offline belongs to the market that is offline, not to every market. */}
      {market?.offline === true ? (
        <p className="text-[12px] leading-5 text-amber-ink" data-recipe-market-offline>
          {t('st.recipe.marketOffline', { name: market.name })}
        </p>
      ) : null}
      {market?.catalog === undefined
        ? <p className="text-[12px] text-ink-faint">{t('st.recipe.marketNoCatalog')}</p>
        : market.catalog.recipes.length === 0
          ? <p className="text-[12px] text-ink-faint">{t('st.recipe.marketEmpty')}</p>
          : <ul className="divide-y divide-hairline border-y border-hairline" data-recipe-market-list>
            {market.catalog.recipes.map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{entry.displayName}</span>
                  <span className="block truncate text-[11px] text-ink-faint">{entry.version}</span>
                </span>
                <button type="button" className={SECONDARY} disabled={install.install.isPending || install.previewAndInstall.isPending}
                  data-recipe-market-install={entry.id}
                  onClick={() => { install.previewAndInstall.mutate({ locator: entry.source, sha256: entry.sha256 }); }}>
                  {t('st.recipe.installOnly')}
                </button>
              </li>
            ))}
          </ul>}
      {/*
        A market row has no room to show a command next to its name, so a package
        that needs authorizing opens the same confirmation the import tab uses,
        with the very same single install button.
      */}
      <ConfirmDialog
        open={install.awaitingConsent !== null}
        stacked
        overlayId="recipe-market-hook-consent"
        title={t('st.recipeHook.consentTitle')}
        confirmLabel={t('st.recipe.installOnly')}
        cancelLabel={t('st.recipeHook.cancelInstall')}
        tone="default"
        busy={install.install.isPending}
        onCancel={() => { install.setAwaitingConsent(null); }}
        onConfirm={() => {
          const candidate = install.awaitingConsent;
          if (candidate !== null) install.install.mutate({ preview: candidate });
        }}>
        {install.awaitingConsent?.hooks === undefined
          ? null
          : (
            <RecipeHookConsentBody
              hooks={install.awaitingConsent.hooks}
              name={install.awaitingConsent.summary.name}
            />
          )}
      </ConfirmDialog>
      {failure !== null ? <p role="alert" className="text-[12px] leading-5 text-danger">{failure}</p> : null}
    </div>
  );
}

function useRecipeMarketInstall(
  setFailure: (text: string | null) => void,
  locale: Locale,
  onPicked: (installationId: string) => void,
) {
  const { t } = useI18n();
  const { client } = useConnection();
  const [awaitingConsent, setAwaitingConsent] = useState<RecipePreview | null>(null);
  const install = useRecipeMutation(
    async (input: { preview: RecipePreview }) =>
      client.installRecipe({ preview_id: input.preview.preview_id, ...recipeConsentField(input.preview) }),
    {
      onSuccess: (summary) => {
        setAwaitingConsent(null);
        setFailure(null);
        onPicked(summary.installation_id);
      },
      onError: (error) => { setAwaitingConsent(null); setFailure(t('st.recipe.installFailed', { detail: errorText(locale, error) })); },
    },
  );
  // A market row is one button, so a package carrying scripts cannot be
  // installed from behind a sheet nobody asked for: the catalog row opens the
  // preview inline and installs from there, which is the same place every other
  // package is confirmed.
  const previewAndInstall = useRecipeMutation(
    async (input: { locator: string; sha256?: string }) => client.previewRecipe({ source: { locator: input.locator, sha256: input.sha256 } }),
    {
      onSuccess: (previewed) => {
        setFailure(null);
        if (recipePreviewNeedsConsent(previewed)) setAwaitingConsent(previewed);
        else install.mutate({ preview: previewed });
      },
      onError: (error) => { setFailure(t('st.recipe.installFailed', { detail: errorText(locale, error) })); },
    },
  );
  return { previewAndInstall, install, awaitingConsent, setAwaitingConsent };
}

/**
 * Import by link or local path; a ZIP additionally carries its digest.
 *
 * The preview is the frozen candidate: it is what the person reads, and it is
 * what gets installed. Nothing is re-resolved at install time, so a command
 * shown in the confirmation is the command that runs.
 *
 * When that candidate declares script hooks the confirmation grows the commands,
 * their events, their sources and their resource files, and says plainly what
 * agreeing authorizes. The button is still "Install and apply", and pressing it
 * is still one decision — there is no second dialog and no separate approval
 * step. `consent` is sent only for a candidate that asked for it, so an ordinary
 * package keeps sending exactly the request it always sent.
 */
function RecipeImportForm({ onInstalled, onApply }: {
  onInstalled: (installationId: string) => void;
  onApply: (installationId: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [locator, setLocator] = useState('');
  const [sha256, setSha256] = useState('');
  const [previewed, setPreviewed] = useState<RecipePreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { client } = useConnection();

  const preview = useRecipeMutation(
    async (input: { locator: string; sha256?: string }) => client.previewRecipe({ source: { locator: input.locator, sha256: input.sha256 } }),
    { onSuccess: setPreviewed, onError: (error) => { setPreviewed(null); setFailure(t('st.recipe.previewFailed', { detail: errorText(locale, error) })); } },
  );
  const install = useRecipeMutation(
    async (input: { preview: RecipePreview; applyAfterInstall: boolean }) =>
      client.installRecipe({ preview_id: input.preview.preview_id, ...recipeConsentField(input.preview) }),
    {
      onSuccess: (summary, input) => {
        setFailure(null);
        setPreviewed(null);
        onInstalled(summary.installation_id);
        if (input.applyAfterInstall) void onApply(summary.installation_id);
      },
      onError: (error) => { setFailure(t('st.recipe.installFailed', { detail: errorText(locale, error) })); },
    },
  );

  const isZip = locator.trim().toLowerCase().endsWith('.zip');
  const hooks = previewed?.hooks;
  const needsConsent = previewed !== null && recipePreviewNeedsConsent(previewed);

  return (
    <form className="min-w-0 space-y-3" data-recipe-import
      onSubmit={(event) => { event.preventDefault(); }}>
      <label className={FORM_LABEL}>
        {t('st.recipe.source')}
        <input className={`${SMALL_INPUT} mt-1 w-full font-mono`} value={locator} data-recipe-import-locator
          placeholder="https://example.com/recipes/clear-work/recipe.toml"
          onChange={(event) => { setLocator(event.target.value); setPreviewed(null); }} />
      </label>
      <label className={FORM_LABEL}>
        {t('st.recipe.sha256')}
        <input className={`${SMALL_INPUT} mt-1 w-full font-mono`} value={sha256} data-recipe-import-sha
          disabled={!isZip && sha256.trim() === ''}
          placeholder={isZip ? t('st.recipe.sha256Required') : t('st.recipe.sha256Optional')}
          onChange={(event) => { setSha256(event.target.value); setPreviewed(null); }} />
      </label>
      <Hint>{t('st.recipe.sourceHelp')}</Hint>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SECONDARY} disabled={preview.isPending || locator.trim() === ''}
          data-recipe-preview
          onClick={() => {
            const trimmed = sha256.trim();
            preview.mutate({ locator: locator.trim(), sha256: trimmed === '' ? undefined : trimmed });
          }}>
          {t(preview.isPending ? 'st.recipe.preparing' : 'st.recipe.previewRecipe')}
        </button>
      </div>

      {previewed !== null ? (
        <div className="space-y-2 border-t border-hairline pt-3" data-recipe-preview>
          <p className="font-display text-[15px] text-ink">{previewed.summary.name}</p>
          <p className="font-mono text-[11px] text-ink-faint">
            {previewed.summary.version} · {recipeRevisionShort(previewed.resolved.revision)}
          </p>
          {previewed.summary.description !== undefined ? (
            <p className="text-[12px] leading-5 text-ink-soft">{previewed.summary.description}</p>
          ) : null}
          {/*
            A candidate that has not been authorized here gets the whole argument
            inline, above the same two buttons that were always there. Pressing
            "Install and apply" *is* the consent — there is no second dialog and
            no separate approval step, because a person who was shown a command
            and what it can reach has nothing left to confirm.
          */}
          {needsConsent && hooks !== undefined ? (
            <RecipeHookConsentBody hooks={hooks} name={previewed.summary.name} />
          ) : hooks === undefined || hooks.scripts.length === 0 ? null : (
            /* Already trusted on this machine: shown, but with nothing to decide. */
            <RecipeHookScripts hooks={hooks} />
          )}
          {previewed.diagnostics.length === 0 ? null : (
            <ul className="space-y-1" data-recipe-preview-diagnostics>
              {previewed.diagnostics.map((diagnostic, index) => (
                <li key={index} className="text-[12px] leading-5 text-amber-ink">
                  {diagnostic.path === undefined ? diagnostic.message : `${diagnostic.path}: ${diagnostic.message}`}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={PRIMARY} disabled={install.isPending}
              data-recipe-install-apply
              onClick={() => { install.mutate({ preview: previewed, applyAfterInstall: true }); }}>
              {t('st.recipe.installAndApply')}
            </button>
            <button type="button" className={SECONDARY} disabled={install.isPending}
              data-recipe-install-only
              onClick={() => { install.mutate({ preview: previewed, applyAfterInstall: false }); }}>
              {t('st.recipe.installOnly')}
            </button>
          </div>
        </div>
      ) : null}

      {failure !== null ? <p role="alert" className="text-[12px] leading-5 text-danger">{failure}</p> : null}
    </form>
  );
}
