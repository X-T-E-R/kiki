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

import { resolveHostPath, type MediaRef } from '@kiki/session-core/composer/media';
import type { MessageAttachment } from '@kiki/session-core/session';

export type MessageMediaKind = 'image' | 'video' | 'audio' | 'file';

export type MessageAttachmentSubtype =
  | 'html'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'csv'
  | 'markdown'
  | 'code'
  | 'archive'
  | 'file';

export interface MessageWebLink {
  readonly url: string;
  readonly hostname: string;
  readonly title: string;
}

const EXTENSION_KIND: Readonly<Record<string, MessageMediaKind>> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', opus: 'audio', flac: 'audio', aac: 'audio',
};

const EXTENSION_SUBTYPE: Readonly<Record<string, MessageAttachmentSubtype>> = {
  html: 'html', htm: 'html', xhtml: 'html',
  pdf: 'pdf',
  docx: 'docx', doc: 'docx',
  xlsx: 'xlsx', xls: 'xlsx',
  pptx: 'pptx', ppt: 'pptx',
  csv: 'csv', tsv: 'csv',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', rs: 'code', go: 'code', java: 'code', c: 'code', cc: 'code', cpp: 'code', h: 'code', hpp: 'code',
  json: 'code', jsonl: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code', css: 'code', scss: 'code',
  sh: 'code', bash: 'code', zsh: 'code', ps1: 'code', sql: 'code', txt: 'code', log: 'code', ini: 'code',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive',
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

export function messageAttachmentSubtype(attachment: MessageAttachment): MessageAttachmentSubtype {
  const name = attachment.title ?? attachment.path;
  const extension = /\.([A-Za-z0-9]+)$/u.exec(name)?.[1]?.toLowerCase();
  if (extension !== undefined && EXTENSION_SUBTYPE[extension] !== undefined) {
    return EXTENSION_SUBTYPE[extension]!;
  }
  const mime = attachment.mimeType?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') return 'csv';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mime === 'application/msword') return 'docx';
  if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel') return 'xlsx';
  if (mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || mime === 'application/vnd.ms-powerpoint') return 'pptx';
  if (mime === 'application/zip' || mime === 'application/gzip' || mime === 'application/x-tar' || mime === 'application/x-7z-compressed') return 'archive';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json')) return 'code';
  return 'file';
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
 * Resolves a local host path for an attachment only when it belongs to the
 * active local session and carries a real filesystem path (never for cross-session
 * receipts or remote connections).
 */
export function resolveSameSessionAttachmentPath(
  attachment: MessageAttachment,
  options?: { readonly readable?: boolean; readonly remote?: boolean; readonly cwd?: string },
): string | undefined {
  if (options?.readable === false || options?.remote === true) return undefined;
  const raw = attachment.path.trim();
  if (
    raw === '' ||
    raw === attachment.blobId ||
    /^(?:blobref|kimi-file|https?|data|blob):/iu.test(raw)
  ) {
    return undefined;
  }
  if (/^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) {
    return resolveHostPath(raw, options?.cwd);
  }
  if (options?.cwd !== undefined && (raw.includes('/') || raw.includes('\\'))) {
    return resolveHostPath(raw, options.cwd);
  }
  return undefined;
}

/**
 * The canonical session-media reference for an attachment. Only the blob id is
 * carried by default: it is the bytes the send stored, and the receipt's `path`
 * is the sender's own machine, which another host cannot read and must not be
 * asked to. When the attachment belongs to the same local session, `hostPath`
 * may be attached so HTML previews resolve their sibling resource tree.
 */
export function messageMediaRef(
  attachment: MessageAttachment,
  kind: MessageMediaKind,
  hostPath?: string,
): MediaRef {
  return {
    kind,
    fileId: attachment.blobId,
    sourceId: attachment.sourceId,
    path: hostPath,
    name: attachmentDisplayName(attachment),
    mime: attachment.mimeType,
    size: attachment.size,
  };
}

const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/giu;
const BARE_URL_RE = /(?<![(\["'])\b(https?:\/\/[^\s<>)\]"']+)/giu;
const IMAGE_URL_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#].*)?$/iu;

function cleanCapturedUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/u, '');
}

function safeDecodeUrlPathname(pathname: string): string {
  if (!pathname || pathname === '/') return '';
  try {
    return decodeURIComponent(pathname).replace(/^\/+/u, '');
  } catch {
    return pathname.replace(/^\/+/u, '');
  }
}

export function extractMessageWebLinks(text: string): readonly MessageWebLink[] {
  if (!text.includes('http://') && !text.includes('https://')) return [];
  const stripped = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]+`/gu, ' ');
  const seen = new Set<string>();
  const links: MessageWebLink[] = [];

  const pushLink = (rawUrl: string, rawTitle?: string) => {
    const url = cleanCapturedUrl(rawUrl.trim());
    if (seen.has(url) || IMAGE_URL_EXT_RE.test(url)) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    seen.add(url);
    const hostname = parsed.hostname.replace(/^www\./iu, '') || parsed.hostname;
    const pathSummary = safeDecodeUrlPathname(parsed.pathname);
    const title =
      rawTitle !== undefined && rawTitle.trim() !== '' && rawTitle.trim() !== url
        ? rawTitle.trim()
        : pathSummary !== ''
          ? `${hostname} / ${pathSummary}`
          : hostname;
    links.push({ url, hostname, title });
  };

  for (const match of stripped.matchAll(MARKDOWN_LINK_RE)) {
    const isImage = match[1] === '!';
    if (isImage) continue;
    pushLink(match[3] ?? '', match[2]);
  }
  for (const match of stripped.matchAll(BARE_URL_RE)) {
    pushLink(match[1] ?? '');
  }
  return links.slice(0, 4);
}
