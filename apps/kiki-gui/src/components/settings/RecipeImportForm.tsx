/**
 * Import by link or local path; a ZIP additionally carries its digest.
 *
 * The preview is the frozen candidate: it is what the person reads, and it is
 * what gets installed. Nothing is re-resolved at install time, so a command
 * shown in the confirmation is the command that runs.
 *
 * When that candidate declares script hooks the confirmation grows the commands,
 * their events, their sources and their resource files, and says plainly what
 * agreeing authorizes. Pressing the install button *is* the consent — there is
 * no second dialog and no separate approval step, because a person who was
 * shown a command and what it can reach has nothing left to confirm. `consent`
 * is sent only for a candidate that asked for it, so an ordinary package keeps
 * sending exactly the request it always sent.
 *
 * The form never writes a model. Where it is opened decides what happens after
 * the package lands: the model picker's import tab additionally applies the
 * new package to the model it was opened from, and the Recipe library opens
 * the package's own page.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { recipeConsentField, recipePreviewNeedsConsent } from '../../lib/recipeHooks';
import { useRecipeMutation } from '../../lib/recipeQueries';
import { recipeRevisionShort, type RecipePreview } from '../../lib/recipes';
import { useConnection } from '../../state/connection';
import { Hint, type Feedback } from '../controls';
import { FORM_LABEL } from './SettingsPrimitives';
import { RecipeHookConsentBody, RecipeHookScripts } from './RecipeHookScripts';
import { SMALL_INPUT } from '../ui';

const PRIMARY = 'rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-deep disabled:cursor-not-allowed disabled:bg-hairline disabled:text-ink-faint';
const SECONDARY = 'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export function RecipeImportForm({ onInstalled, onApply, onFeedback }: {
  onInstalled: (installationId: string) => void;
  /**
   * The model picker's extra write. When it is set the form offers
   * "Install and apply" next to the plain install; when it is not, installing
   * is the whole decision, which is the Recipe library's case.
   */
  onApply?: (installationId: string) => Promise<void>;
  /** Where the host wants its feedback line; unset renders one in place. */
  onFeedback?: (feedback: Feedback) => void;
}) {
  const { t, locale } = useI18n();
  const [locator, setLocator] = useState('');
  const [sha256, setSha256] = useState('');
  const [previewed, setPreviewed] = useState<RecipePreview | null>(null);
  const [ownFeedback, setOwnFeedback] = useState<Feedback>(null);
  const { client } = useConnection();
  const setFeedback = onFeedback ?? setOwnFeedback;

  const preview = useRecipeMutation(
    async (input: { locator: string; sha256?: string }) => client.previewRecipe({ source: { locator: input.locator, sha256: input.sha256 } }),
    {
      onSuccess: setPreviewed,
      onError: (error) => { setPreviewed(null); setFeedback({ tone: 'error', text: t('st.recipe.previewFailed', { detail: errorText(locale, error) }) }); },
    },
  );
  const install = useRecipeMutation(
    async (input: { preview: RecipePreview; applyAfterInstall: boolean }) =>
      client.installRecipe({ preview_id: input.preview.preview_id, ...recipeConsentField(input.preview) }),
    {
      onSuccess: (summary, input) => {
        setFeedback(null);
        setPreviewed(null);
        onInstalled(summary.installation_id);
        if (input.applyAfterInstall && onApply !== undefined) void onApply(summary.installation_id);
      },
      onError: (error) => { setFeedback({ tone: 'error', text: t('st.recipe.installFailed', { detail: errorText(locale, error) }) }); },
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
        <div className="space-y-2 pt-3" data-recipe-preview>
          <p className="font-display text-[15px] text-ink">{previewed.summary.name}</p>
          <p className="font-mono text-[11px] text-ink-faint">
            {previewed.summary.version} · {recipeRevisionShort(previewed.resolved.revision)}
          </p>
          {previewed.summary.description !== undefined ? (
            <p className="text-[12px] leading-5 text-ink-soft">{previewed.summary.description}</p>
          ) : null}
          {needsConsent && hooks !== undefined ? (
            <RecipeHookConsentBody hooks={hooks} name={previewed.summary.name} />
          ) : hooks === undefined || hooks.scripts.length === 0 ? null : (
            /* Already trusted on this machine: shown, with nothing to decide. */
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
            {onApply === undefined ? null : (
              <button type="button" className={PRIMARY} disabled={install.isPending}
                data-recipe-install-apply
                onClick={() => { install.mutate({ preview: previewed, applyAfterInstall: true }); }}>
                {t('st.recipe.installAndApply')}
              </button>
            )}
            <button type="button" className={onApply === undefined ? PRIMARY : SECONDARY} disabled={install.isPending}
              data-recipe-install-only
              onClick={() => { install.mutate({ preview: previewed, applyAfterInstall: false }); }}>
              {t('st.recipe.installOnly')}
            </button>
          </div>
        </div>
      ) : null}

      {onFeedback === undefined && ownFeedback !== null ? (
        <p role="alert" className="text-[12px] leading-5 text-danger">{ownFeedback.text}</p>
      ) : null}
    </form>
  );
}
