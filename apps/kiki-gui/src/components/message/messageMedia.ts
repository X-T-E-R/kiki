/**
 * A delivered message's attachments, read the way the receipt declared them.
 *
 * The receipt carries the sender's delivery intent (`kind`: image, audio,
 * voice, video, file — an open set) next to the bytes it stored. That intent
 * decides how the attachment is drawn; only a receipt that predates the field
 * falls back to the media type. An intent is never inferred back from a MIME
 * type, so a plain audio file is not presented as a voice note, and a voice
 * note is not reduced to a file chip.
 */

import type { MediaRef } from '@kiki/session-core/composer/media';
import type { MessageAttachment } from '@kiki/session-core/session';

export type MessageMediaKind = 'image' | 'video' | 'audio' | 'file';

const EXTENSION_KIND: Readonly<Record<string, MessageMediaKind>> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', opus: 'audio', flac: 'audio', aac: 'audio',
};

/**
 * The kind a receipt attachment reports: its declared intent, else the media
 * type the receipt recorded, else the file's own extension — a display
 * decision, not a claim about what the sender asked for.
 */
export function messageMediaKind(attachment: MessageAttachment): MessageMediaKind {
  const declared = attachment.kind?.trim().toLowerCase();
  if (declared === 'image' || declared === 'video' || declared === 'audio' || declared === 'voice') {
    return declared === 'voice' ? 'audio' : declared;
  }
  if (declared === 'file') return 'file';
  const mime = attachment.mimeType?.toLowerCase() ?? '';
  const slash = mime.indexOf('/');
  if (slash > 0) {
    const family = mime.slice(0, slash);
    if (family === 'image' || family === 'video' || family === 'audio') return family;
  }
  const name = attachment.title ?? attachment.path;
  const extension = /\.([A-Za-z0-9]+)$/u.exec(name)?.[1]?.toLowerCase();
  return extension === undefined ? 'file' : EXTENSION_KIND[extension] ?? 'file';
}

/** A voice note is the sender's declared intent; an audio file stays audio. */
export function isVoiceIntent(attachment: MessageAttachment): boolean {
  return attachment.kind?.trim().toLowerCase() === 'voice';
}

/** The receipt's own kind token, for matching a channel's `unsupported` list. */
export function attachmentReceiptKind(attachment: MessageAttachment): string {
  const kind = attachment.kind?.trim();
  return kind === undefined || kind === '' ? 'file' : kind;
}

export function attachmentDisplayName(attachment: MessageAttachment): string {
  if (attachment.title !== undefined && attachment.title.trim() !== '') return attachment.title;
  const leaf = attachment.path.split(/[\\/]/u).at(-1);
  return leaf === undefined || leaf === '' ? attachment.path : leaf;
}

/**
 * The canonical session-media reference for an attachment. Only the blob id is
 * carried: it is the bytes the send stored, and the receipt's `path` is the
 * sender's own machine, which another host cannot read and must not be asked
 * to.
 */
export function messageMediaRef(attachment: MessageAttachment, kind: MessageMediaKind): MediaRef {
  return {
    kind,
    fileId: attachment.blobId,
    name: attachmentDisplayName(attachment),
    mime: attachment.mimeType,
    size: attachment.size,
  };
}
