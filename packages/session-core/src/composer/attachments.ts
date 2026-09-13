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
 */

import type { FileContent, ImageContent, MessageContent } from '@kiki/protocol';

import { LocalizedError, type ValidationIssue } from '../i18n/locale';

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

export type ComposerAttachment = FileMention | ImageAttachment | UploadAttachment;

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

/** Reads a pasted/dropped image File into an attachment (base64 + preview). */
export function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const readFailed = () =>
      new LocalizedError({
        key: 'attach.readFailed',
        params: { name: file.name === '' ? '(image)' : file.name },
      });
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
 * that gate (defensive, never the intended path).
 */
export function buildPromptContent(
  text: string,
  attachments: readonly ComposerAttachment[],
): MessageContent[] | null {
  const mentions = attachments.filter((item): item is FileMention => item.kind === 'file');
  const images = attachments.filter((item): item is ImageAttachment => item.kind === 'image');
  const uploads = attachments.filter((item): item is UploadAttachment => item.kind === 'upload');
  const parts: string[] = [];
  if (mentions.length > 0) parts.push(mentions.map(mentionToken).join(' '));
  if (text.trim() !== '') parts.push(text.trim());
  const content: MessageContent[] = [];
  if (parts.length > 0) content.push({ type: 'text', text: parts.join('\n\n') });
  for (const image of images) {
    const part: ImageContent = {
      type: 'image',
      source: { kind: 'base64', media_type: image.mediaType, data: image.data },
    };
    content.push(part);
  }
  for (const upload of uploads) {
    if (upload.fileId === undefined) continue;
    const part: FileContent = {
      type: 'file',
      file_id: upload.fileId,
      name: upload.name,
      media_type: upload.mediaType,
      size: upload.size,
    };
    content.push(part);
  }
  return content.length > 0 ? content : null;
}

/**
 * Attachments for skill activation: the wire accepts image/video/file parts
 * (text stays in `args`), so images and uploaded files carry over and file
 * mentions fold into the args string as `@path` tokens.
 */
export function buildSkillActivation(
  args: string,
  attachments: readonly ComposerAttachment[],
): { args: string; attachments?: (ImageContent | FileContent)[] } {
  const mentions = attachments.filter((item): item is FileMention => item.kind === 'file');
  const images = attachments.filter((item): item is ImageAttachment => item.kind === 'image');
  const uploads = attachments.filter((item): item is UploadAttachment => item.kind === 'upload');
  const mergedArgs = [mentions.map(mentionToken).join(' '), args.trim()]
    .filter((part) => part !== '')
    .join(' ');
  const media: (ImageContent | FileContent)[] = images.map((image) => ({
    type: 'image' as const,
    source: { kind: 'base64' as const, media_type: image.mediaType, data: image.data },
  }));
  for (const upload of uploads) {
    if (upload.fileId === undefined) continue;
    media.push({
      type: 'file',
      file_id: upload.fileId,
      name: upload.name,
      media_type: upload.mediaType,
      size: upload.size,
    });
  }
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

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
