import { useMemo } from 'react';
import { shiftTextPresentation } from '@kiki/transcript';
import type { UserBlock } from '@kiki/session-core/session';
import {
  findThreadRefs,
  parseSelectionCarryovers,
  prepareThreadRefContext,
  reconcileEditedThreadRefs,
  retainedAttachmentsFromContent,
  selectionCarryoverPresentation,
  type ComposerAttachment,
} from '@kiki/session-core/composer';
import { useThreadRefDirectory } from '../../lib/threadRefs';
import { UserMessageEditor } from '../RowActions';
import type { TranscriptRowActions } from '../Transcript';
import { displayUserMessageText, editableUserMessageText } from './messageSource';

export function EditUserRow({ block, rowActions, onClose }: { block: UserBlock; rowActions: Pick<TranscriptRowActions, 'onEditMessage' | 'loadEditAttachments'>; onClose: () => void }) {
  const display = useMemo(() => displayUserMessageText(block), [block]);
  const carry = useMemo(() => parseSelectionCarryovers(display.text, display.presentation), [display.text, display.presentation]);
  const bodyText = carry.body;
  const editInitialText = useMemo(() => {
    if (display.text === block.text) return bodyText;
    return editableUserMessageText(block);
  }, [display.text, block, bodyText]);
  const initialEditAttachments = useMemo<readonly ComposerAttachment[]>(() => {
    if (block.queuedContent !== undefined) {
      return retainedAttachmentsFromContent(block.queuedContent);
    }
    if (block.media !== undefined && block.media.length > 0) {
      return block.media.flatMap((mediaItem): ComposerAttachment[] => {
        const url = mediaItem.blobHash === undefined ? mediaItem.url : `blobref:${mediaItem.mime};${mediaItem.blobHash}`;
        if (mediaItem.kind === 'file') {
          const fileId = mediaItem.fileId;
          if (fileId === undefined) return [];
          return [{ kind: 'retained', name: mediaItem.name ?? fileId, content: { type: 'file', file_id: fileId, name: mediaItem.name ?? fileId, media_type: mediaItem.mime ?? 'application/octet-stream', size: mediaItem.size ?? 0 } }];
        }
        if (url === undefined && mediaItem.fileId === undefined) return [];
        return [{
          kind: 'retained',
          name: mediaItem.name ?? mediaItem.kind,
          content: {
            type: mediaItem.kind,
            name: mediaItem.name,
            source: url !== undefined ? { kind: 'url', url } : { kind: 'session_media', file_id: mediaItem.fileId! },
          },
          previewUrl: url !== undefined && /^(?:data:|blob:|https?:)/.test(url) ? url : undefined,
        }];
      });
    }
    return [];
  }, [block.queuedContent, block.media]);
  const threadRefDirectory = useThreadRefDirectory(
    useMemo(() => findThreadRefs(bodyText).map((ref) => ref.sessionId), [bodyText]),
  );
  return (
    <UserMessageEditor
      initialText={editInitialText}
      initialAttachments={initialEditAttachments}
      loadAttachments={rowActions.loadEditAttachments === undefined ? undefined : (signal) => rowActions.loadEditAttachments!(block, signal)}
      onSubmit={async (text, attachments, editedPresentation) => {
        const prepared = reconcileEditedThreadRefs(block, editedPresentation === undefined
          ? prepareThreadRefContext(text, threadRefDirectory.info)
          : { text, presentation: editedPresentation });
        const selections = selectionCarryoverPresentation(carry.selections, []);
        const presentation = { spans: [...selections.presentation.spans, ...(shiftTextPresentation(prepared.presentation, selections.prefix.length)?.spans ?? [])] };
        await rowActions.onEditMessage(block, selections.prefix + prepared.text, attachments, presentation);
        onClose();
      }}
      onCancel={onClose}
    />
  );
}
