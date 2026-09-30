/**
 * MessageRow — one piece of speech a Bot actually delivered (SendMessage),
 * set like a colleague's chat line: face and name once per run of the same
 * speaker, then prose with no bubble fill. The user's own lines keep the
 * existing right-aligned bubble (Transcript's UserMessage), so only one
 * voice sits on a surface.
 *
 * Streaming: while the call runs, the draft reads the completed prefix of
 * `text` out of the argument JSON and grows with a caret. A cancelled or
 * failed call leaves one quiet line instead of the bubble.
 */

import { memo, useMemo, type ReactNode } from 'react';

import type { MessageAttachment, MessageBlock } from '@kiki/session-core/session';
import { formatBytes } from '@kiki/session-core/composer/media';

import { useI18n } from '../../i18n';
import { streamingMessageText } from '../../lib/partialJson';
import { Markdown } from '../Markdown';
import { useMediaPreview } from '../mediaPreviewContext';
import { PersonaAvatar, type PersonaAvatarData } from '../persona/PersonaAvatar';
import { RelativeTime } from '../RelativeTime';
import { Icon } from '../icons';

export interface MessageSpeaker {
  readonly persona: PersonaAvatarData;
}

/** Who a message speaks as: the receipt's sender, else the session's persona, else a neutral agent face. */
export function speakerOf(block: MessageBlock, fallback: PersonaAvatarData | undefined, agentLabel: string): PersonaAvatarData {
  if (block.personaId !== undefined) {
    const sameAsFallback = fallback !== undefined && fallback.id === block.personaId;
    return {
      id: block.personaId,
      name: block.senderName ?? fallback?.name ?? block.personaId,
      avatarUrl: sameAsFallback ? fallback.avatarUrl : `/api/personas/${encodeURIComponent(block.personaId)}/avatar`,
    };
  }
  return fallback ?? { id: 'kiki-agent', name: agentLabel };
}

/** The visible text: the committed text once sent, the partial draft while sending. */
export function messageDraftText(block: MessageBlock): string {
  if (block.status !== 'sending') return block.text;
  const argsText = block.sourceTool?.argsText ?? '';
  const draft = argsText === '' ? '' : streamingMessageText(argsText);
  return draft !== '' ? draft : block.text;
}

/** Face column shared by every message-view row, so text starts on one axis. */
export const MESSAGE_FACE = 'w-6 shrink-0 max-sm:w-5';

export function SpeakerHead({
  persona,
  at,
  children,
}: {
  readonly persona: PersonaAvatarData;
  readonly at?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2">
      <span className={MESSAGE_FACE}>
        <PersonaAvatar persona={persona} size={24} decorative className="max-sm:!h-5 max-sm:!w-5 !rounded-[6px]" />
      </span>
      <span data-message-sender className="min-w-0 truncate text-[13px] leading-5 font-medium text-ink">{persona.name}</span>
      {children}
      {at !== undefined ? (
        <span className="shrink-0 text-[12px] text-ink-faint tabular-nums opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100">
          <RelativeTime at={at} />
        </span>
      ) : null}
    </div>
  );
}

function AttachmentCard({ attachment, readable }: { readonly attachment: MessageAttachment; readonly readable: boolean }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const name = attachment.title ?? attachment.path.split(/[\\/]/).pop() ?? attachment.path;
  const detail = [attachment.size === undefined ? undefined : formatBytes(attachment.size), attachment.mimeType]
    .filter((part): part is string => part !== undefined).join(' · ');
  const openable = preview !== null && readable;
  return (
    <div data-message-attachment={attachment.blobId} className="flex max-w-full items-center gap-2 rounded-lg bg-panel py-2 pr-2 pl-3 ring-1 ring-hairline sm:max-w-[360px]">
      <span className="text-ink-faint"><Icon name="file" size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[12.5px] text-ink" title={attachment.path}>{name}</span>
        {detail !== '' ? <span className="block truncate text-[11.5px] text-ink-faint">{detail}</span> : null}
      </span>
      {openable ? (
        <button
          type="button"
          data-message-attachment-open
          onClick={() => {
            // The receipt's blob id is already a canonical session-media id
            // (`blobref:<agent>:<sha>`); it is passed through untouched.
            preview.openAttachment({ kind: 'file', fileId: attachment.blobId, name, mime: attachment.mimeType, size: attachment.size });
          }}
          className="min-h-8 shrink-0 rounded-md px-2 text-[12px] font-medium text-ink-soft transition-colors hover:bg-ink/[0.05] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {t('message.openAttachment')}
        </button>
      ) : null}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({
  block,
  speaker,
  continued,
  replyToText,
  onOpenProcess,
  currentSessionId,
}: {
  readonly block: MessageBlock;
  readonly currentSessionId?: string;
  readonly speaker: PersonaAvatarData;
  /** Same speaker as the row above: no face or name, tighter spacing. */
  readonly continued: boolean;
  /** Quoted text of the message this one replies to, when it is on the page. */
  readonly replyToText?: string;
  readonly onOpenProcess?: () => void;
}) {
  const { t } = useI18n();
  const text = messageDraftText(block);
  const sending = block.status === 'sending';
  const at = block.startedAt === undefined ? undefined : new Date(block.startedAt).toISOString();
  // The preview reads media through the open session; a blob owned by another
  // sender session is shown but not opened from here.
  const readable = block.sourceSessionId === undefined || block.sourceSessionId === currentSessionId;
  const quote = useMemo(() => replyToText?.replace(/\s+/g, ' ').trim(), [replyToText]);

  if (block.status === 'failed' || block.status === 'cancelled') {
    return (
      <div data-message-row={block.id} data-message-status={block.status} className="flex items-center gap-2">
        <span className={MESSAGE_FACE} />
        <button
          type="button"
          onClick={onOpenProcess}
          disabled={onOpenProcess === undefined}
          className={`min-h-6 rounded-sm text-left text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
            block.status === 'failed' ? 'text-danger hover:underline' : 'text-ink-faint hover:text-ink-soft'
          }`}
        >
          {t(block.status === 'failed' ? 'message.failed' : 'message.cancelled')}
        </button>
      </div>
    );
  }

  return (
    <div
      data-message-row={block.id}
      data-message-status={block.status}
      data-message-origin={block.origin}
      className="anim-enter group/msg min-w-0"
    >
      {continued ? null : <SpeakerHead persona={speaker} at={at} />}
      <div className="flex min-w-0 gap-2">
        <span className={MESSAGE_FACE} />
        <div className="min-w-0 flex-1">
          {quote !== undefined && quote !== '' ? (
            <p data-message-reply className="mb-1 truncate border-l-2 border-hairline-strong pl-2 text-[12.5px] text-ink-faint">
              {t('message.replyTo', { text: quote })}
            </p>
          ) : null}
          <div data-message-text className="kiki-prose min-w-0">
            {sending ? (
              <div className="kiki-prose-tail break-words whitespace-pre-wrap text-ink">
                {text}
                <span className="stream-caret font-mono">▍</span>
              </div>
            ) : (
              <Markdown text={text} />
            )}
          </div>
          {block.attachments.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {block.attachments.map((attachment) => (
                <AttachmentCard key={attachment.blobId} attachment={attachment} readable={readable} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
