/**
 * Download a Recipe as a portable ZIP.
 *
 * This is the answer to a package whose source is `installation:<id>`: that
 * locator identifies a package inside this machine's install store and means
 * nothing to anybody else. The server's `export` resolves the inheritance chain
 * into a self-contained file map first, so what lands on disk opens on its own
 * rather than pointing back at a parent that is not there.
 *
 * Exporting reads and installs nothing: it is not a second copy of the package
 * and it does not bind a model.
 */

import { useState } from 'react';

import { errorText } from '@kiki/session-core/i18n';
import { useI18n } from '../../i18n';
import { downloadRecipeZip, recipeExportZipName, zipRecipeFiles } from '../../lib/recipeExport';
import { useConnection } from '../../state/connection';


const SECONDARY = 'rounded-md border border-hairline bg-paper px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50';

export function DownloadZipButton({ installationId, name }: { installationId: string; name: string }) {
  const { t, locale } = useI18n();
  const { client } = useConnection();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  return (
    <div className="contents">
      <button type="button" className={SECONDARY} disabled={busy} data-recipe-download-zip={installationId}
        onClick={() => {
          setBusy(true);
          setFailure(null);
          void client.exportRecipe(installationId).then((snapshot) => {
            downloadRecipeZip(zipRecipeFiles(snapshot.files), recipeExportZipName({
              name: snapshot.name === '' ? name : snapshot.name,
              version: snapshot.revision.replace(/^sha256:/u, '').slice(0, 8),
            }));
          }).catch((error: unknown) => {
            setFailure(t('st.recipe.exportFailed', { detail: errorText(locale, error) }));
          }).finally(() => { setBusy(false); });
        }}>
        {t(busy ? 'st.recipe.exporting' : 'st.recipe.downloadZip')}
      </button>
      {failure !== null
        ? <p role="alert" className="w-full text-[12px] leading-5 text-danger" data-recipe-export-error>{failure}</p>
        : null}

    </div>
  );
}
