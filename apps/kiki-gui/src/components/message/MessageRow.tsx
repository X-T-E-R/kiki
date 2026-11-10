/**
 * MessageRow — one piece of speech a Bot actually delivered (SendMessage) or
 * ended a turn on, set like a colleague's chat line: face and name once per
 * run of the same speaker, then prose with no bubble fill. The user's own
 * lines keep the existing right-aligned bubble (Transcript's UserMessage), so
 * only one voice sits on a surface.
 *
 * Streaming: while the call runs, the draft reads the completed prefix of
 * `text` out of the argument JSON and grows with a caret. A cancelled or
 * failed call leaves one quiet line instead of the bubble.
 *
 * Delivery: a receipt reports each destination. Speech is claimed only for a
 * channel that delivered into this conversation; a message that reached
 * another destination is set under its own destination line, and an outcome no
 * channel confirmed says so instead of passing for a delivered message. The
 * attachments follow the receipt's declared media kinds — a kind this
 * conversation did not receive is named, not drawn as sent.
 *
 * A long body arrives from the wire as a preview with a continuation ref (the
 * same bounded-content contract every other reading area uses); the row reads
 * the rest of its own field, so what the Bot said is never silently cut.
 */

import { memo, useMemo, useState, type ReactNode } from 'react';

import type { MessageAttachment, MessageBlock } from '@kiki/session-core/session';
import type { MediaRef } from '@kiki/session-core/composer/media';
import { formatBytes } from '@kiki/session-core/composer/media';
import type { I18nKey } from '@kiki/session-core/i18n';

import { openExternalUrl, useHost } from '../../host';
import { useI18n } from '../../i18n';
import { streamingMessageText } from '../../lib/partialJson';
import { useOptionalConnection } from '../../state/connection';
import { Markdown } from '../Markdown';
import { ContentContinuation, frameContentSource, INPUT_ROOTS, INPUT_TEXT_ROOTS, MESSAGE_TEXT_ROOTS } from '../ContentContinuation';
import { isRemoteConnection } from '../imageActions';
import { useMediaPreview } from '../mediaPreviewContext';
import { MediaPart, useSessionMedia, useVisibleOnce } from '../mediaParts';
import { PersonaAvatar, type PersonaAvatarData } from '../persona/PersonaAvatar';
import { RelativeTime } from '../RelativeTime';
import { DisclosureChevron, Icon, type IconName } from '../icons';
import { CopyButton } from '../timeline/ContentCopyButton';
import { plainFailure } from '../agent-panel/failureText';
import { DeliveryNotes, withheldKinds } from './messageDelivery';
import {
  attachmentDisplayName,
  attachmentReceiptKind,
  extractMessageWebLinks,
  isVoiceIntent,
  messageAttachmentSubtype,
  messageMediaKind,
  messageMediaRef,
  resolveSameSessionAttachmentPath,
  type MessageAttachmentSubtype,
  type MessageMediaKind,
  type MessageWebLink,
} from './messageMedia';

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
  const draft = argsText === '' ? '' : streamingMessageText(argsText, block.itemIndex);
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
        <PersonaAvatar persona={persona} size={24} decorative className={`max-sm:!h-5 max-sm:!w-5 ${persona.avatarShape === 'circle' ? '' : '!rounded-[6px]'}`} />
      </span>
      <span data-message-sender className="min-w-0 truncate text-[13px] leading-5 font-medium text-ink">{persona.name}</span>
      {children}
      {at !== undefined ? (
        <span className="shrink-0 text-[12px] text-ink-faint tabular-nums opacity-0 transition-opacity duration-[var(--kiki-motion-quick)] group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 [@media(hover:none)]:opacity-100">
          <RelativeTime at={at} />
        </span>
      ) : null}
    </div>
  );
}

interface SubtypeStyle {
  readonly badge: string;
  readonly icon: IconName;
  readonly labelKey: I18nKey;
  readonly badgeClass: string;
}

const SUBTYPE_STYLE: Readonly<Record<MessageAttachmentSubtype, SubtypeStyle>> = {
  html: {
    badge: 'HTML',
    icon: 'web',
    labelKey: 'message.media.html',
    badgeClass: 'border-accent/35 bg-accent/[0.08] text-accent',
  },
  pdf: {
    badge: 'PDF',
    icon: 'read',
    labelKey: 'message.media.pdf',
    badgeClass: 'border-danger/30 bg-danger/[0.07] text-danger',
  },
  docx: {
    badge: 'DOCX',
    icon: 'read',
    labelKey: 'message.media.docx',
    badgeClass: 'border-hairline-strong bg-ink/[0.05] text-ink-soft',
  },
  xlsx: {
    badge: 'XLSX',
    icon: 'board',
    labelKey: 'message.media.xlsx',
    badgeClass: 'border-sage-rule/50 bg-sage-card text-sage-ink',
  },
  pptx: {
    badge: 'PPTX',
    icon: 'board',
    labelKey: 'message.media.pptx',
    badgeClass: 'border-amber-rule/50 bg-amber-card text-amber-ink',
  },
  csv: {
    badge: 'CSV',
    icon: 'board',
    labelKey: 'message.media.csv',
    badgeClass: 'border-sage-rule/50 bg-sage-card text-sage-ink',
  },
  markdown: {
    badge: 'MD',
    icon: 'notes',
    labelKey: 'message.media.markdown',
    badgeClass: 'border-hairline-strong bg-ink/[0.05] text-ink-soft',
  },
  code: {
    badge: 'CODE',
    icon: 'terminal',
    labelKey: 'message.media.code',
    badgeClass: 'border-hairline-strong bg-ink/[0.05] text-ink-soft',
  },
  archive: {
    badge: 'ZIP',
    icon: 'folder',
    labelKey: 'message.media.archive',
    badgeClass: 'border-hairline bg-ink/[0.04] text-ink-faint',
  },
  file: {
    badge: 'FILE',
    icon: 'file',
    labelKey: 'message.media.file',
    badgeClass: 'border-hairline bg-ink/[0.04] text-ink-faint',
  },
};

function attachmentDetail(
  attachment: MessageAttachment,
  subtype: MessageAttachmentSubtype,
  readable: boolean,
  t: (key: I18nKey) => string,
): string {
  const typeLabel = t(SUBTYPE_STYLE[subtype].labelKey);
  const sizeLabel = attachment.size === undefined ? undefined : formatBytes(attachment.size);
  const crossSessionLabel = readable ? undefined : t('message.media.crossSession');
  return [typeLabel, sizeLabel, crossSessionLabel]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}

function AttachmentCard({
  attachment,
  kind,
  readable,
}: {
  readonly attachment: MessageAttachment;
  readonly kind: MessageMediaKind;
  readonly readable: boolean;
}) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const connection = useOptionalConnection();
  const remote = isRemoteConnection(connection);
  const name = attachmentDisplayName(attachment);
  const subtype = messageAttachmentSubtype(attachment);
  const style = SUBTYPE_STYLE[subtype];
  const detail = attachmentDetail(attachment, subtype, readable, t);
  const openable = preview !== null && readable;
  const hostPath = useMemo(
    () => (subtype === 'html' ? resolveSameSessionAttachmentPath(attachment, { readable, remote, cwd: preview?.cwd }) : undefined),
    [attachment, readable, remote, subtype, preview?.cwd],
  );
  const openAttachment = () => {
    if (!openable) return;
    const ref = messageMediaRef(attachment, kind, hostPath);
    if (preview.openAttachmentInWorkspace !== undefined) {
      preview.openAttachmentInWorkspace(ref);
    } else {
      preview.openAttachment(ref);
    }
  };

  return (
    <div
      data-message-attachment={attachment.blobId}
      data-message-attachment-subtype={subtype}
      data-message-attachment-readable={readable ? 'true' : 'false'}
      onClick={openable ? openAttachment : undefined}
      className={`flex max-w-full items-center gap-2.5 rounded-xl bg-panel py-2 pr-2.5 pl-3 ring-1 ring-hairline transition-colors sm:max-w-[400px] ${
        openable ? 'cursor-pointer hover:ring-hairline-strong' : 'opacity-80'
      }`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.04] text-ink-soft">
        <Icon name={style.icon} size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-wide ${style.badgeClass}`}>
            {style.badge}
          </span>
          <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink" title={readable ? attachment.path : name}>
            {name}
          </span>
        </span>
        {detail !== '' ? (
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-faint">{detail}</span>
        ) : null}
      </span>
      {openable ? (
        <button
          type="button"
          data-message-attachment-open
          onClick={(event) => {
            event.stopPropagation();
            openAttachment();
          }}
          className="min-h-7 shrink-0 rounded-lg border border-hairline bg-paper px-2.5 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        >
          {t('message.openAttachment')}
        </button>
      ) : null}
    </div>
  );
}

function WebLinkPreviewCard({ link }: { readonly link: MessageWebLink }) {
  const host = useHost();
  const { t } = useI18n();
  const preview = useMediaPreview();
  const openInWorkspace = () => {
    if (preview?.openWeb !== undefined) {
      preview.openWeb(link.url, link.title);
    } else {
      void openExternalUrl(host, link.url, t('common.popupBlocked'));
    }
  };
  return (
    <div
      data-message-web-preview={link.url}
      onClick={openInWorkspace}
      className="flex max-w-full cursor-pointer items-center gap-2.5 rounded-xl bg-panel py-2 pr-2.5 pl-3 ring-1 ring-hairline transition-colors hover:ring-hairline-strong sm:max-w-[400px]"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink/[0.04] text-ink-soft">
        <Icon name="compass" size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 rounded border border-hairline-strong bg-ink/[0.05] px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium tracking-wide text-ink-soft">
            WEB
          </span>
          <span className="min-w-0 truncate text-[12.5px] font-medium text-ink" title={link.url}>
            {link.title}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-ink-faint">
          {link.hostname} · {t('message.media.web')}
        </span>
      </span>
      <button
        type="button"
        data-message-web-open
        onClick={(event) => {
          event.stopPropagation();
          openInWorkspace();
        }}
        className="min-h-7 shrink-0 rounded-lg border border-hairline bg-paper px-2.5 py-1 text-[11.5px] font-medium text-ink-soft transition-colors hover:border-accent hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t('message.openAttachment')}
      </button>
      <button
        type="button"
        data-message-web-external
        title={t('message.openInBrowser')}
        aria-label={t('message.openInBrowser')}
        onClick={(event) => {
          event.stopPropagation();
          void openExternalUrl(host, link.url, t('common.popupBlocked'));
        }}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-ink/[0.06] hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Icon name="external" size={12} />
      </button>
    </div>
  );
}

/**
 * A delivered picture or clip: the share reads as the picture, not as a file
 * row. A clip keeps a play mark over its poster so it is not mistaken for a
 * still picture.
 */
function VisualAttachment({ attachment, kind }: { readonly attachment: MessageAttachment; readonly kind: 'image' | 'video' }) {
  const item = useMemo(() => messageMediaRef(attachment, kind), [attachment, kind]);
  if (kind === 'image') return <MediaPart item={item} />;
  return (
    <span className="relative inline-flex">
      <MediaPart item={item} />
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink/45">
          <span className="ml-0.5 h-0 w-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-paper" />
        </span>
      </span>
    </span>
  );
}

/**
 * A delivered voice note or audio file. The player reads the same canonical
 * session bytes the attachment preview uses; nothing decodes or re-encodes the
 * media here, and a voice intent is only a label on what the platform carried.
 */
function AudioAttachment({ attachment, voice }: { readonly attachment: MessageAttachment; readonly voice: boolean }) {
  const { t } = useI18n();
  const preview = useMediaPreview();
  const item = useMemo<MediaRef>(() => messageMediaRef(attachment, 'audio'), [attachment]);
  const [slot, visible] = useVisibleOnce();
  const load = useSessionMedia(item, preview?.sessionId, visible, false);
  const caption = [t(voice ? 'message.media.voice' : 'message.media.audio'), attachmentDisplayName(attachment),
    attachment.size === undefined ? undefined : formatBytes(attachment.size)]
    .filter((part): part is string => part !== undefined && part !== '').join(' · ');
  let body: ReactNode;
  if (load.status === 'ready') {
    body = <audio controls preload="none" src={load.url} aria-label={caption} className="h-10 w-full max-w-[320px]" />;
  } else if (load.status === 'failed') {
    body = (
      <button
        type="button"
        data-message-media-failed
        onClick={() => { preview?.openAttachment(item); }}
        disabled={preview === null}
        className="flex h-10 min-w-0 max-w-[320px] items-center gap-2 rounded-lg bg-panel px-3 text-left ring-1 ring-hairline transition-colors hover:ring-hairline-strong focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
      >
        <Icon name="file" size={14} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 truncate font-mono text-[12px] text-ink">{attachmentDisplayName(attachment)}</span>
      </button>
    );
  } else {
    body = <span aria-busy="true" className="block h-10 w-[240px] max-w-full rounded-lg bg-ink/[0.04]" />;
  }
  return (
    <div ref={slot} data-message-media="audio" data-message-voice={voice ? '' : undefined} className="flex min-w-0 flex-col gap-1">
      {body}
      <span className="text-[11.5px] text-ink-faint">{caption}</span>
    </div>
  );
}

/** One receipt attachment, drawn as what the send declared it to be. */
export function MessageAttachmentView({ attachment, readable }: { readonly attachment: MessageAttachment; readonly readable: boolean }) {
  const kind = messageMediaKind(attachment);
  if (kind === 'file' || !readable) {
    return (
      <div data-message-media={kind}>
        <AttachmentCard attachment={attachment} kind={kind} readable={readable} />
      </div>
    );
  }
  return (
    <div data-message-media={kind} data-message-voice={isVoiceIntent(attachment) ? '' : undefined}>
      {kind === 'audio'
        ? <AudioAttachment attachment={attachment} voice={isVoiceIntent(attachment)} />
        : <VisualAttachment attachment={attachment} kind={kind} />}
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
  const [failureOpen, setFailureOpen] = useState(false);
  const text = messageDraftText(block);
  const sending = block.status === 'sending';
  const at = block.startedAt === undefined ? undefined : new Date(block.startedAt).toISOString();
  // The preview reads media through the open session; a blob owned by another
  // sender session is shown but not opened from here.
  const readable = block.sourceSessionId === undefined || block.sourceSessionId === currentSessionId;
  const quote = useMemo(() => replyToText?.replace(/\s+/g, ' ').trim(), [replyToText]);
  // Where this body came from decides which bounded field continues: a
  // promoted reply is assistant prose, a delivered message is the call's own
  // argument text.
  const source = block.sourceBlock !== undefined
    ? frameContentSource(block.sourceBlock)
    : block.sourceTool === undefined ? undefined : frameContentSource(block.sourceTool);
  const roots = block.sourceBlock !== undefined
    ? MESSAGE_TEXT_ROOTS
    : block.sourceTool?.args === undefined ? INPUT_TEXT_ROOTS : INPUT_ROOTS;
  // Attachments this conversation's own channel reported it did not receive:
  // they are named in the delivery notes instead of drawn as delivered media.
  const withheld = withheldKinds(block);
  const attachments = block.attachments.filter((attachment) => !withheld.has(attachmentReceiptKind(attachment)));
  // Pictures and clips sit together as a share would; a note or a document
  // keeps its own row below them.
  const visual = attachments.filter((attachment) => readable
    && (messageMediaKind(attachment) === 'image' || messageMediaKind(attachment) === 'video'));
  const stacked = attachments.filter((attachment) => !visual.includes(attachment));
  const webLinks = useMemo(() => (sending ? [] : extractMessageWebLinks(text)), [sending, text]);
  const spokenElsewhere = block.reached === 'elsewhere';
  const unconfirmed = block.status === 'pending' || block.reached === 'unconfirmed';

  if (block.status === 'failed' || block.status === 'cancelled') {
    return (
      <div data-message-row={block.id} data-message-status={block.status} className="flex flex-col">
        <div className="flex items-center gap-2">
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
        <div className="flex gap-2">
          <span className={MESSAGE_FACE} />
          <div className="min-w-0 flex-1">
            {block.failureDetail === undefined ? null : (
              <div className="flex max-w-full min-w-0 items-start gap-1">
                <button
                  type="button"
                  data-message-failure-detail
                  aria-expanded={failureOpen}
                  title={failureOpen ? undefined : block.failureDetail}
                  onClick={() => { setFailureOpen((value) => !value); }}
                  className="flex max-w-full min-w-0 flex-1 cursor-pointer items-start gap-1 rounded-sm py-0.5 text-left font-mono text-[11.5px] leading-relaxed text-ink-faint transition-colors hover:text-ink-soft focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className={failureOpen ? 'min-w-0 flex-1 break-words whitespace-pre-wrap' : 'min-w-0 flex-1 truncate'}>
                    {failureOpen ? block.failureDetail : (plainFailure(block.failureDetail) ?? block.failureDetail)}
                  </span>
                  <DisclosureChevron open={failureOpen} className="mt-1 shrink-0" />
                </button>
                {failureOpen ? (
                  <CopyButton text={block.failureDetail} label={t('transcript.promptOutcome.details')} />
                ) : null}
              </div>
            )}
            <DeliveryNotes block={block} onOpenProcess={onOpenProcess} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-message-row={block.id}
      data-message-status={block.status}
      data-message-origin={block.origin}
      data-message-reached={block.reached}
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
          {spokenElsewhere || unconfirmed ? <DeliveryNotes block={block} onOpenProcess={onOpenProcess} /> : null}
          <div data-message-text className={`kiki-prose min-w-0 ${spokenElsewhere || unconfirmed ? 'mt-1' : ''}`}>
            {sending ? (
              <div className="kiki-prose-tail break-words whitespace-pre-wrap text-ink">
                {text}
                <span className="stream-caret font-mono">▍</span>
              </div>
            ) : (
              <Markdown text={text} />
            )}
          </div>
          {sending || source === undefined ? null : (
            <ContentContinuation source={source} roots={roots} label={t('message.body')} className="mt-1" />
          )}
          {attachments.length > 0 || webLinks.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {visual.length > 0 ? (
                <div className="flex flex-wrap items-start gap-2">
                  {visual.map((attachment) => (
                    <MessageAttachmentView key={attachment.blobId} attachment={attachment} readable={readable} />
                  ))}
                </div>
              ) : null}
              {stacked.map((attachment) => (
                <MessageAttachmentView key={attachment.blobId} attachment={attachment} readable={readable} />
              ))}
              {webLinks.map((link) => (
                <WebLinkPreviewCard key={link.url} link={link} />
              ))}
            </div>
          ) : null}
          {spokenElsewhere || unconfirmed ? null : <DeliveryNotes block={block} onOpenProcess={onOpenProcess} />}
        </div>
      </div>
    </div>
  );
});
