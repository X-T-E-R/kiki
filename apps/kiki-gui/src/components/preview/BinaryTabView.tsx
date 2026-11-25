/**
 * Unsupported / binary file preview fallback tab.
 */

import { basenameOf } from '@kiki/session-core/composer/media';
import { useHost } from '#/host';
import { useI18n } from '#/i18n';
import { usePhoneMode } from '#/lib/layoutHooks';
import { useOptionalConnection } from '#/state/connection';
import type { PreviewReadFailureReason } from '#/state/previewResource';
import { Icon } from '../icons';
import { PreviewHeaderActionsPortal, usePreviewHeaderSlot } from './PreviewHeaderSlot';
import { HeaderFileActions } from './ResourceHeader';
import {
  CAPTION_ACTION_CLASS,
  downloadHostFile,
  isLocalKikiComputer,
  PreviewReadFailureView,
  useFileOpeners,
} from './shared';

export function BinaryTabView({
  path,
  sessionId,
  workspaceRoot,
  visible = true,
  reason = 'unsupported',
}: {
  readonly path: string;
  readonly sessionId?: string;
  readonly workspaceRoot?: string;
  readonly visible?: boolean;
  readonly reason?: Extract<PreviewReadFailureReason, 'unsupported' | 'corrupted'>;
}) {
  const host = useHost();
  const { t } = useI18n();
  const phoneMode = usePhoneMode();
  const headerSlot = usePreviewHeaderSlot();
  const useUnifiedHead = visible && headerSlot.unifiedHead && headerSlot.actionsSlot !== null;
  const compact = phoneMode || headerSlot.widthTier === 'compact';
  const connection = useOptionalConnection();
  const localKikiComputer = isLocalKikiComputer(connection);
  const name = basenameOf(path);
  const openers = useFileOpeners();
  const headerControls = compact ? (
    <HeaderFileActions
      path={path}
      name={name}
      sessionId={sessionId}
      workspaceRoot={workspaceRoot}
      resourceType="unsupported"
      canDownload
      failureReason={reason}
      widthTier={headerSlot.widthTier}
    />
  ) : openers?.reveal !== undefined ? (
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
  ) : null;
  return (
    <>
      {useUnifiedHead ? (
        <PreviewHeaderActionsPortal active={visible}>
          {headerControls}
        </PreviewHeaderActionsPortal>
      ) : (
        <div data-preview-secondary-bar className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint" title={path}>
            {compact ? name : path}
          </span>
          {headerControls}
        </div>
      )}
      <PreviewReadFailureView
        reason={reason}
        path={path}
        onDownload={() => {
          const client = connection?.client;
          if (client !== undefined) {
            void downloadHostFile(host, client, path, name, t, {
              sessionId,
              workspaceRoot,
              localKikiComputer,
            });
          }
        }}
      />
    </>
  );
}
