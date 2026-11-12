/**
 * Unsupported / binary file preview fallback tab.
 */

import { basenameOf } from '@kiki/session-core/composer/media';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { useOptionalConnection } from '#/state/connection';
import type { PreviewReadFailureReason } from '#/state/previewResource';
import { Icon } from '../icons';
import {
  CAPTION_ACTION_CLASS,
  downloadHostFile,
  PreviewReadFailureView,
  useFileOpeners,
} from './shared';

export function BinaryTabView({
  path,
  reason = 'unsupported',
}: {
  readonly path: string;
  readonly reason?: Extract<PreviewReadFailureReason, 'unsupported' | 'corrupted'>;
}) {
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
      <PreviewReadFailureView
        reason={reason}
        path={path}
        onDownload={() => {
          const client = connection?.client;
          if (client !== undefined) void downloadHostFile(host, client, path, name, t);
        }}
      />
    </>
  );
}
