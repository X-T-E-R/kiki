import { resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import type { MessageAttachment } from '@kiki/session-core/session';

import type { KikiClient } from '../lib/client';
import type { MediaPreviewApi } from './mediaPreviewContext';
import { trustedAttachmentOrigin } from './message/messageMedia';

export interface ResolvedLocalAttachment {
  readonly origin?: { readonly path: string; readonly trusted: true };
  /**
   * Local filesystem path when the attachment can be opened directly on this
   * computer without bouncing through a read-only session copy first.
   */
  readonly localPath?: string;
}

/**
 * Resolve whether a same-session message attachment has a directly openable
 * local file path on the current Kiki computer.
 */
export function resolveDirectLocalAttachment(
  attachment: MessageAttachment,
  options: {
    readonly readable: boolean;
    readonly remote: boolean;
    readonly localKikiComputer?: boolean;
    readonly isHtml?: boolean;
    readonly cwd?: string;
  },
): ResolvedLocalAttachment {
  const origin = trustedAttachmentOrigin(attachment, { readable: options.readable });
  if (!options.readable || options.remote || options.localKikiComputer === false || origin === undefined) {
    return { origin };
  }
  return {
    origin,
    localPath: resolveHostPath(origin.path, options.cwd),
  };
}

/**
 * Resolve whether a non-visual MediaRef (such as a session-copy file chip) has
 * a trusted local origin path on the current Kiki computer that can be probed
 * directly on click with preserved-copy fallback.
 */
export function resolveDirectLocalMediaRef(
  item: MediaRef,
  options: {
    readonly localKikiComputer: boolean;
    readonly cwd?: string;
  },
): string | undefined {
  if (!options.localKikiComputer) return undefined;
  if (item.kind === 'image' || item.kind === 'video') return undefined;
  if (item.origin?.trusted === true && item.origin.path.trim() !== '') {
    return resolveHostPath(item.origin.path, options.cwd);
  }
  return undefined;
}

/**
 * Open a local attachment directly as a live file when it exists on disk,
 * falling back to the preserved session copy if the local file is gone or
 * unreadable.
 */
export function openAttachmentDirectly(options: {
  readonly localPath?: string;
  readonly preview: MediaPreviewApi | null;
  readonly client: Pick<KikiClient, 'previewHostFile'> | undefined;
  readonly openCopy: () => void;
}): void {
  const { localPath, preview, client, openCopy } = options;
  if (preview === null) return;
  if (localPath === undefined) {
    openCopy();
    return;
  }
  const probe =
    client !== undefined && typeof client.previewHostFile === 'function'
      ? client.previewHostFile.bind(client)
      : undefined;
  if (probe === undefined) {
    preview.openFile(localPath);
    return;
  }
  void probe(localPath, 1)
    .then(() => {
      preview.openFile(localPath);
    })
    .catch(() => {
      openCopy();
    });
}
