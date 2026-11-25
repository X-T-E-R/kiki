/**
 * Composer attachments — `@` file mentions and pasted/dropped images.
 *
 * Wire honesty:
 *   - File mentions ride the prompt TEXT as `@path` tokens — exactly what the
 *     kimi TUI produces when a user accepts its mention autocomplete
 *     (`file-mention-provider.ts` inserts `@path` / `@"path with spaces"`).
 *     The model resolves the path with its Read tool; nothing is invented.
 *   - Images go as real `{type:'image', source:{kind:'base64', …}}` content
 *     parts. The server format-gates and compresses them
 *     (kap-server `lib/promptMedia.ts`); the client-side MIME whitelist below
 *     mirrors the server's `MODEL_ACCEPTED_IMAGE_MIMES` exactly.
 *   - Any OTHER dropped/pasted file is uploaded eagerly (`POST /files`) and
 *     sent as a real `{type:'file', file_id, …}` content part; the server
 *     materializes it next to the session as a path-referenced attachment the
 *     model opens with the Read tool. Chips carry the file id once the upload
 *     lands; sending blocks while an upload is in flight.
 *   - SSH hosts are NOT message content. A host joined to a session lives on
 *     the server's session host list for the whole conversation, so neither the
 *     prompt nor a skill activation mentions it. The `ssh` attachment kind
 *     survives only for a draft that has not created its session yet.
 */

import type { AudioContent, FileContent, ImageContent, VideoContent, MessageContent } from '@kiki/protocol';

import { LocalizedError, type ValidationIssue } from '../i18n/locale';
import { formatBytes } from '../util/bytes';

export interface FileMention {
  kind: 'file';
  /** Workspace-relative path from `fs:search`. */
  path: string;
  name: string;
  isDir: boolean;
}

export interface ImageAttachment {
  kind: 'image';
  name: string;
  mediaType: string;
  /** Base64 payload (no data-URL prefix). */
  data: string;
  /** Decoded byte size. */
  size: number;
  /** data: URL for the chip thumbnail. */
  previewUrl: string;
}

export interface RetainedAttachment {
  kind: 'retained';
  name: string;
  content: Extract<MessageContent, { type: 'image' | 'video' | 'audio' | 'file' }>;
  /** In-memory preview of the original; submissions retain the canonical content. */
  previewUrl?: string;
}

export interface SshHostAttachment {
  kind: 'ssh';
  id: string;
  name: string;
}

export type ComposerAttachment = FileMention | ImageAttachment | UploadAttachment | RetainedAttachment | SshHostAttachment;

/** Preserve existing media parts verbatim when opening a message for editing. */
export function retainedAttachmentsFromContent(content: readonly MessageContent[]): RetainedAttachment[] {
  return content.flatMap((part): RetainedAttachment[] => {
    if (part.type !== 'image' && part.type !== 'video' && part.type !== 'audio' && part.type !== 'file') return [];
    return [{ kind: 'retained', name: part.name ?? (part.type === 'file' ? part.file_id : part.type), content: part }];
  });
}

/**
 * Preserve historical SSH-shaped text without guessing whether the user wrote it.
 * Resident SSH hosts come from the session host list, not message syntax.
 */
export function parseSshHostContext(text: string): { body: string; hosts: readonly SshHostAttachment[] } {
  return { body: text, hosts: [] };
}

/**
 * A dropped/pasted non-image file, uploaded to the server's file store at
 * attach time and sent as a `{type:'file'}` content part. `fileId` is absent
 * only while the upload is in flight (the chip shows a busy placeholder and
 * the composer blocks sending, exactly like reading image stubs).
 */
export interface UploadAttachment {
  kind: 'upload';
  name: string;
  /** The browser-reported MIME; empty file types normalize to octet-stream. */
  mediaType: string;
  size: number;
  /** Server file id from `POST /files`. */
  fileId?: string;
}

/** Mirror of the server's MODEL_ACCEPTED_IMAGE_MIMES (image-format-policy.ts). */
export const ACCEPTED_IMAGE_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** Client-side caps: one oversized inline base64 body would fail the request. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
/**
 * Uploaded files are streamed to disk server-side (no server cap — local
 * single-user deployment), so the client cap only guards the browser-side
 * fetch/multipart path against pathological picks.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Returns a localized validation issue when the file cannot be attached, else null. */
export function validateImageFile(
  file: { name: string; size: number; type: string },
  current: readonly ComposerAttachment[],
): ValidationIssue | null {
  if (!ACCEPTED_IMAGE_MIMES.includes(file.type)) {
    return file.type === ''
      ? { key: 'attach.imageTypeUnknown', params: { name: file.name } }
      : { key: 'attach.imageType', params: { name: file.name, type: file.type } };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      key: 'attach.imageTooLarge',
      params: { name: file.name, size: formatBytes(file.size), max: formatBytes(MAX_IMAGE_BYTES) },
    };
  }
  const used = current
    .filter((item): item is ImageAttachment => item.kind === 'image')
    .reduce((sum, item) => sum + item.size, 0);
  if (used + file.size > MAX_TOTAL_IMAGE_BYTES) {
    return { key: 'attach.totalTooLarge', params: { max: formatBytes(MAX_TOTAL_IMAGE_BYTES) } };
  }
  if (current.length >= MAX_ATTACHMENTS) {
    return { key: 'attach.tooMany', params: { max: MAX_ATTACHMENTS } };
  }
  return null;
}

/**
 * Reserve image capacity synchronously before FileReader work begins. Callers
 * can carry `next` into another same-tick reservation instead of validating
 * against a stale rendered attachment array.
 */
export function reserveImageFiles<T extends { name: string; size: number; type: string }>(
  files: readonly T[],
  current: readonly ComposerAttachment[],
): {
  readonly accepted: readonly T[];
  readonly stubs: readonly ImageAttachment[];
  readonly next: readonly ComposerAttachment[];
  readonly lastProblem: ValidationIssue | null;
} {
  let next = current;
  const accepted: T[] = [];
  const stubs: ImageAttachment[] = [];
  let lastProblem: ValidationIssue | null = null;
  for (const file of files) {
    const problem = validateImageFile(file, next);
    if (problem !== null) {
      lastProblem = problem;
      continue;
    }
    const stub: ImageAttachment = {
      kind: 'image',
      name: file.name,
      mediaType: file.type,
      data: '',
      size: file.size,
      previewUrl: '',
    };
    accepted.push(file);
    stubs.push(stub);
    next = [...next, stub];
  }
  return { accepted, stubs, next, lastProblem };
}

/**
 * Non-image files have no format whitelist: the wire contract accepts any
 * `{type:'file'}` part and the server materializes the bytes for the Read
 * tool. Only size and the shared count cap apply.
 */
export function validateUploadFile(
  file: { name: string; size: number },
  current: readonly ComposerAttachment[],
): ValidationIssue | null {
  if (file.size > MAX_FILE_BYTES) {
    return {
      key: 'attach.fileTooLarge',
      params: { name: file.name, size: formatBytes(file.size), max: formatBytes(MAX_FILE_BYTES) },
    };
  }
  if (current.length >= MAX_ATTACHMENTS) {
    return { key: 'attach.tooMany', params: { max: MAX_ATTACHMENTS } };
  }
  return null;
}

/**
 * Reserve upload slots synchronously before the `POST /files` calls begin —
 * same same-tick batching contract as {@link reserveImageFiles}.
 */
export function reserveUploadFiles<T extends { name: string; size: number; type: string }>(
  files: readonly T[],
  current: readonly ComposerAttachment[],
): {
  readonly accepted: readonly T[];
  readonly stubs: readonly UploadAttachment[];
  readonly next: readonly ComposerAttachment[];
  readonly lastProblem: ValidationIssue | null;
} {
  let next = current;
  const accepted: T[] = [];
  const stubs: UploadAttachment[] = [];
  let lastProblem: ValidationIssue | null = null;
  for (const file of files) {
    const problem = validateUploadFile(file, next);
    if (problem !== null) {
      lastProblem = problem;
      continue;
    }
    const stub: UploadAttachment = {
      kind: 'upload',
      name: file.name,
      mediaType: file.type === '' ? 'application/octet-stream' : file.type,
      size: file.size,
    };
    accepted.push(file);
    stubs.push(stub);
    next = [...next, stub];
  }
  return { accepted, stubs, next, lastProblem };
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const nativeToBase64 = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof nativeToBase64 === 'function') {
    return nativeToBase64.call(bytes);
  }
  const nodeBuffer = (
    globalThis as {
      Buffer?: {
        from(buf: ArrayBufferLike, byteOffset: number, length: number): { toString(enc: 'base64'): string };
      };
    }
  ).Buffer;
  if (typeof nodeBuffer?.from === 'function') {
    return nodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  const CHUNK = 32_768;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.byteLength));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

const mintedPreviewObjectUrls = new Set<string>();

/** Revoke a `blob:` preview URL minted by `fileToImageAttachment`. */
export function revokeAttachmentPreviewUrl(attachment: ComposerAttachment): void {
  if (attachment.kind !== 'image' && attachment.kind !== 'retained') return;
  const url = attachment.previewUrl;
  if (url === undefined || !mintedPreviewObjectUrls.has(url)) return;
  mintedPreviewObjectUrls.delete(url);
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

/** Revoke all minted `blob:` preview URLs in a list of attachments. */
export function revokeAttachmentPreviewUrls(attachments: readonly ComposerAttachment[] | undefined): void {
  if (attachments === undefined) return;
  for (const attachment of attachments) revokeAttachmentPreviewUrl(attachment);
}

/** Reads a pasted/dropped image File into an attachment (base64 + preview). */
export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  const readFailed = () =>
    new LocalizedError({
      key: 'attach.readFailed',
      params: { name: file.name === '' ? '(image)' : file.name },
    });
  if (typeof file.arrayBuffer === 'function') {
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      throw readFailed();
    }
    const bytes = new Uint8Array(buffer);
    const data = encodeBytesToBase64(bytes);
    let previewUrl: string;
    if (
      file.size > 65_536 &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      file instanceof Blob
    ) {
      previewUrl = URL.createObjectURL(file);
      mintedPreviewObjectUrls.add(previewUrl);
    } else {
      previewUrl = `data:${file.type};base64,${data}`;
    }
    return {
      kind: 'image',
      name: file.name,
      mediaType: file.type,
      data,
      size: file.size,
      previewUrl,
    };
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => { reject(readFailed()); };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (!result.startsWith('data:') || comma === -1) {
        reject(readFailed());
        return;
      }
      resolve({
        kind: 'image',
        // An empty name means a clipboard image; the chip renders a
        // localized "pasted image" label for it.
        name: file.name,
        mediaType: file.type,
        data: result.slice(comma + 1),
        size: file.size,
        previewUrl: result,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Dedupe guard: the same workspace path should not chip twice. */
export function hasMention(attachments: readonly ComposerAttachment[], path: string): boolean {
  return attachments.some((item) => item.kind === 'file' && item.path === path);
}

/** `@path` token for one mention; quotes paths containing whitespace (TUI convention). */
export function mentionToken(mention: FileMention): string {
  const path = mention.isDir ? `${mention.path}/` : mention.path;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Builds the wire content for a send: mention tokens fold into the text part,
 * images follow as real image parts, uploaded files as `{type:'file'}` parts.
 * Returns null when there is nothing to send (caller keeps the composer open).
 * Upload stubs without a file id yet are skipped — the composer blocks sending
 * while any upload is in flight, so a skipped stub means the caller bypassed
 * that gate (defensive, never the intended path). An `ssh` item is a session
 * resource the composer already granted; it contributes nothing here.
 */
export function buildPromptContent(
  text: string,
  attachments: readonly ComposerAttachment[],
  presentation?: import('@kiki/transcript').TextPresentation,
): MessageContent[] | null {
  const mentions = attachments.filter((item): item is FileMention => item.kind === 'file');
  const typedText = text.trim();
  const mentionText = mentions.map(mentionToken).join(' ');
  const parts: string[] = [];
  if (mentionText !== '') parts.push(mentionText);
  if (typedText !== '') parts.push(typedText);
  const content: MessageContent[] = [];
  if (parts.length > 0) {
    const contentText = parts.join('\n\n');
    const typedTextOffset = mentionText !== '' && typedText !== '' ? mentionText.length + 2 : 0;
    const rawToContentOffset = typedTextOffset - (text.length - text.trimStart().length);
    const mappedSpans = typedText === '' ? [] : presentation?.spans.flatMap((span) => {
      const start = Math.max(typedTextOffset, Math.min(contentText.length, span.start + rawToContentOffset));
      const end = Math.max(start, Math.min(contentText.length, span.end + rawToContentOffset));
      return end > start ? [{ ...span, start, end }] : [];
    }) ?? [];
    const mappedPresentation = mappedSpans.length > 0 ? { spans: mappedSpans } : undefined;
    content.push({ type: 'text', text: contentText, presentation: mappedPresentation });
  }
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      const part: ImageContent = {
        type: 'image',
        source: { kind: 'base64', media_type: attachment.mediaType, data: attachment.data },
      };
      content.push(part);
      continue;
    }
    if (attachment.kind === 'upload') {
      if (attachment.fileId === undefined) continue;
      const normalizedMime = attachment.mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (normalizedMime.startsWith('audio/')) {
        const part: AudioContent = {
          type: 'audio',
          source: { kind: 'file', file_id: attachment.fileId },
          name: attachment.name === '' ? undefined : attachment.name,
        };
        content.push(part);
        continue;
      }
      const part: FileContent = {
        type: 'file',
        file_id: attachment.fileId,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      };
      content.push(part);
      continue;
    }
    if (attachment.kind === 'retained') {
      content.push(attachment.content);
    }
  }
  return content.length > 0 ? content : null;
}

/**
 * Attachments for skill activation: the wire accepts image/video/file parts
 * (text stays in `args`), so images and uploaded files carry over and file
 * mentions fold into the args string as `@path` tokens. An `ssh` item is a
 * session resource, not activation input, and stays out of `args`.
 */
export function buildSkillActivation(
  args: string,
  attachments: readonly ComposerAttachment[],
): { args: string; attachments?: (ImageContent | VideoContent | FileContent)[] } {
  const mentions = attachments.filter((item): item is FileMention => item.kind === 'file');
  const mergedArgs = [mentions.map(mentionToken).join(' '), args.trim()]
    .filter((part) => part !== '')
    .join(' ');
  const media = (buildPromptContent('', attachments) ?? []).filter(
    (part): part is ImageContent | VideoContent | FileContent => part.type === 'image' || part.type === 'video' || part.type === 'file',
  );
  return { args: mergedArgs, attachments: media.length > 0 ? media : undefined };
}

/**
 * Locates the `@` mention token being typed: an `@` at the draft start or
 * after whitespace, with a whitespace-free query up to the cursor.
 */
export function parseMentionTrigger(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

const PASTED_MEDIA_MIMES_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  wmv: 'video/x-ms-wmv',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

const PASTED_VIDEO_MIMES = new Set(
  Object.values(PASTED_MEDIA_MIMES_BY_EXTENSION).filter((mime) => mime.startsWith('video/')),
);

const PASTED_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'audio/aac',
]);

/** Clipboard and dropped media follows the image whitelist plus uploaded video and audio formats. */
export function pastedMediaType(file: { readonly name: string; readonly type: string }): string | null {
  const extension = file.name.includes('.') ? (file.name.split('.').at(-1)?.toLowerCase() ?? '') : '';
  const mime =
    (file.type || PASTED_MEDIA_MIMES_BY_EXTENSION[extension] || '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? '';
  return ACCEPTED_IMAGE_MIMES.includes(mime) || PASTED_VIDEO_MIMES.has(mime) || PASTED_AUDIO_MIMES.has(mime)
    ? mime
    : null;
}

export { formatBytes };
