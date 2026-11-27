import { useEffect, useMemo, useRef, useState } from 'react';
import { shiftTextPresentation, type TextPresentation } from '@kiki/transcript';
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
import { useI18n } from '../../i18n';
import { useThreadRefDirectory } from '../../lib/threadRefs';
import { Composer } from '../Composer';
import { mergeLoadedAttachments } from '../RowActions';
import type { TranscriptRowActions } from '../Transcript';
import { useTranscriptTarget } from '../transcriptDetail';
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

function UserMessageEditor({
  initialText,
  initialAttachments = [],
  loadAttachments,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  initialAttachments?: readonly ComposerAttachment[];
  loadAttachments?: (signal: AbortSignal) => Promise<readonly ComposerAttachment[]>;
  onSubmit: (text: string, attachments: readonly ComposerAttachment[], presentation?: TextPresentation) => void | Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const target = useTranscriptTarget();
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>(initialAttachments);
  const [loading, setLoading] = useState(loadAttachments !== undefined);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const loaderRef = useRef(loadAttachments);
  loaderRef.current = loadAttachments;
  const initialRef = useRef(initialAttachments);

  useEffect(() => {
    const load = loaderRef.current;
    if (load === undefined) {
      setLoading(false);
      return;
    }
    let active = true;
    const abort = new AbortController();
    setLoading(true);
    setLoadError(false);
    void load(abort.signal).then((media) => {
      if (active) {
        setAttachments((current) => mergeLoadedAttachments(current, media, initialRef.current));
      }
    })
      .catch(() => { if (active) setLoadError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [attempt]);

  const cancel = () => { if (!submitting) onCancel(); };
  return (
    <div data-edit-editor className="w-full max-w-[85%]">
      <Composer
        busy={false}
        disabled={submitting}
        sendDisabled={loading || loadError || submitting}
        sendDisabledTitle={loading ? t('preview.loading') : loadError ? t('preview.failed') : undefined}
        variant="subagent" messageEditing autoFocus
        sessionId={target?.sessionId} agentId={target?.agentId}
        value={text} onChange={setText}
        attachments={attachments} onChangeAttachments={setAttachments}
        model={undefined} defaultModel={undefined} serverDefaultModel={undefined}
        modelSource="server-default" agentProfileCatalogMode={{ mode: 'global' }}
        permissionMode="manual" planMode={false} efforts={undefined} effort={undefined}
        onChangeModel={() => {}} onChangePermissionMode={() => {}}
        onChangePlanMode={() => {}} onChangeEffort={() => {}}
        onQueueEditCancel={cancel}
        onSend={async (body, media, options) => {
          setSubmitting(true);
          try { await onSubmit(body, media, options?.presentation); } finally { setSubmitting(false); }
        }}
      />
      {loadError ? (
        <div className="mt-2 flex items-center px-1">
          <button
            type="button"
            data-edit-retry
            onClick={() => { setAttempt((value) => value + 1); }}
            className="cursor-pointer text-[11px] text-danger hover:underline"
          >
            {t('preview.failed')} · {t('transcript.detail.retry')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
