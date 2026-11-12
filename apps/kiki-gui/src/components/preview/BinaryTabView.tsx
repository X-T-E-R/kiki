/**
 * Unsupported / binary file preview fallback tab.
 */

import { basenameOf } from '@kiki/session-core/composer/media';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { useOptionalConnection } from '#/state/connection';
import { Icon } from '../icons';
import {
  BODY_ACTION_CLASS,
  CAPTION_ACTION_CLASS,
  downloadHostFile,
  useFileOpeners,
} from './shared';

export function BinaryTabView({ path }: { readonly path: string }) {
  const host = useHost();
  const { t } = useI18n();
  const connection = useOptionalConnection();
  const name = basenameOf(path);
  const openers = useFileOpeners();
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
          {path}
        </span>
        {openers?.reveal !== undefined ? (
          <button
            type="button"
            title={t('file.showInFolder')}
            aria-label={t('file.showInFolder')}
            data-reveal-file
            onClick={() => { openers.reveal!(path); }}
            className={CAPTION_ACTION_CLASS}
          >
            <Icon name="folder" size={14} />
          </button>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col items-start gap-3 p-4">
        <p className="text-[12.5px] text-ink-soft">{t('preview.unsupported')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-download-file
            onClick={() => {
              const client = connection?.client;
              if (client !== undefined) void downloadHostFile(host, client, path, name);
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-on-accent transition-colors hover:bg-accent-deep"
          >
            {t('media.download')}
          </button>
          {openers?.open !== undefined ? (
            <button
              type="button"
              title={t('file.openDefaultApp')}
              data-open-default-app
              onClick={() => { openers.open!(path); }}
              className={BODY_ACTION_CLASS}
            >
              {t('file.open')}
            </button>
          ) : null}
          {openers?.reveal !== undefined ? (
            <button
              type="button"
              data-reveal-file
              onClick={() => { openers.reveal!(path); }}
              className={BODY_ACTION_CLASS}
            >
              {t('file.showInFolder')}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
