/**
 * Media helpers for the transcript: structured refs for image/video/file
 * content parts (replacing the old `[image]` placeholder flattening), tool
 * result media extraction (ReadMediaFile-style engine part arrays), and the
 * local-file link resolution behind clickable file paths + previews.
 *
 * Wire facts (packages/protocol/src/message.ts, kap-server messageProjection):
 *   - message image/video parts carry `source: { kind: 'url' | 'base64' | 'file' }`;
 *     base64 data is bare (no data-URL prefix), url may itself be a data: URI.
 *   - file parts are daemon upload references (file_id + name + size); the
 *     session media route resolves both canonical media and staged uploads.
 *   - tool results with media keep the raw engine part array as `output`:
 *     `[{ type: 'text', text: '<image path="/abs/x.png">' },
 *       { type: 'image_url', imageUrl: { url: 'data:…' } }, …]`.
 */

import { type Message } from '@kiki/protocol';
import { mediaUrlFromPart, parseMediaBlobRef } from '@kiki/transcript';

/** A renderable (or at least describable) media reference from a message part. */
export interface MediaRef {
  readonly kind: 'image' | 'video' | 'file';
  /** Ready-to-use URL: a data: URI, blob: URL, or remote http(s) URL. */
  readonly url?: string;
  /** Absolute host path, when the part references a file on disk. */
  readonly path?: string;
  /** Persisted tool-result bytes, scoped to the session and producing agent. */
  readonly blobHash?: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size?: number;
  /** Canonical session-media or staged-upload id, resolved through the session. */
  readonly fileId?: string;
  /**
   * The transcript window omitted this attachment's source (too large or an
   * inline data URL); read it by reference when the user opens it.
   */
  readonly detail?: { readonly agentId: string; readonly attachmentId: string };
}

type ContentPart = Message['content'][number];

function mimeFromDataUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = /^data:([^;,]+)/.exec(url);
  return match?.[1];
}

function refFromSource(
  kind: 'image' | 'video',
  source: Extract<ContentPart, { type: 'image' }>['source'],
): MediaRef {
  switch (source.kind) {
    case 'base64':
      return {
        kind,
        url: `data:${source.media_type};base64,${source.data}`,
        mime: source.media_type,
      };
    case 'url':
      return mediaRefFromUrl(kind, source.url);
    case 'file':
    case 'session_media':
      return { kind, fileId: source.file_id };
  }
}

const DAEMON_FILE_RE = /^kimi-file:\/\/([^?]*)/;

/**
 * A media ref for a message part addressed by URL. Persisted history rewrites
 * inline image bytes to agent-scoped `blobref:<mime>;<sha256>` references and
 * uploads to `kimi-file://<fileId>`; neither scheme is browser-loadable, so
 * they become a blob hash / session media id the preview resolves through the
 * session media route. Anything else that a browser cannot load (an empty
 * daemon id, an unknown scheme) keeps no url, so the preview degrades to a
 * file chip instead of a broken image.
 */
export function mediaRefFromUrl(
  kind: 'image' | 'video',
  url: string,
  extra?: Pick<MediaRef, 'name' | 'mime' | 'size'>,
): MediaRef {
  const blobref = parseMediaBlobRef(url);
  if (blobref?.kind === 'mime') {
    return { kind, name: extra?.name, size: extra?.size, mime: blobref.mime, blobHash: blobref.hash };
  }
  const daemon = DAEMON_FILE_RE.exec(url);
  if (daemon !== null) {
    const fileId = daemon[1] ?? '';
    return { kind, ...extra, fileId: fileId === '' ? undefined : fileId };
  }
  if (!BROWSER_MEDIA_URL_RE.test(url)) return { kind, ...extra };
  return { kind, ...extra, url, mime: extra?.mime ?? mimeFromDataUrl(url) };
}

/** Collect the structured media parts of a wire message content array. */
export function mediaFromContentParts(content: readonly ContentPart[]): MediaRef[] {
  const media: MediaRef[] = [];
  for (const part of content) {
    if (part.type === 'image' || part.type === 'video') {
      media.push(refFromSource(part.type, part.source));
    } else if (part.type === 'file') {
      media.push({
        kind: 'file',
        fileId: part.file_id,
        name: part.name,
        mime: part.media_type,
        size: part.size,
      });
    }
  }
  return media;
}

// ---------------------------------------------------------------------------
// Tool result media
// ---------------------------------------------------------------------------

export interface ToolOutputMedia {
  /** Text parts joined, with image/video wrapper tags stripped. */
  readonly text: string;
  readonly media: readonly MediaRef[];
}

const MEDIA_TAG_RE = /<(\/?)(image|video)\b([^>]*)>/gi;
const MEDIA_PATH_RE = /\bpath=(?:"([^"]*)"|'([^']*)')/i;
const BROWSER_MEDIA_URL_RE = /^(?:data:|blob:|https?:\/\/)/i;

function toolMediaRef(ref: MediaRef, path: string | undefined): MediaRef {
  const url = ref.url;
  if (url?.startsWith('blobref:')) {
    const match = parseMediaBlobRef(url);
    if (match?.kind === 'mime' && match.mime.startsWith(`${ref.kind}/`)) {
      return { ...ref, url: undefined, path, mime: match.mime, blobHash: match.hash };
    }
    return { ...ref, url: undefined, path: undefined, name: path, mime: undefined };
  }
  return {
    ...ref,
    url: url !== undefined && BROWSER_MEDIA_URL_RE.test(url) ? url : undefined,
    path,
  };
}



/**
 * Split a tool result output into renderable text + media when it carries
 * engine content parts (ReadMediaFile & friends). Returns undefined for plain
 * strings, JSON-able objects, and arrays without media, so callers keep their
 * existing fallback rendering for those.
 */
export function extractToolOutputMedia(output: unknown): ToolOutputMedia | undefined {
  if (!Array.isArray(output)) return undefined;
  const media: MediaRef[] = [];
  const texts: string[] = [];
  let pending: { kind: 'image' | 'video'; path: string } | undefined;
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const part = item as Record<string, unknown>;
    if (part['type'] === 'text') {
      const text = part['text'];
      if (typeof text !== 'string') continue;
      for (const tag of text.matchAll(MEDIA_TAG_RE)) {
        const kind = tag[2]?.toLowerCase() as 'image' | 'video';
        if (tag[1] === '/') {
          if (pending?.kind === kind) pending = undefined;
        } else {
          const path = MEDIA_PATH_RE.exec(tag[3] ?? '')?.slice(1).find((value) => value !== undefined && value !== '');
          pending = path === undefined ? undefined : { kind, path };
        }
      }
      const cleaned = text.replaceAll(MEDIA_TAG_RE, '').trim();
      if (cleaned !== '') texts.push(cleaned);
      continue;
    }
    const engineRef = part['type'] === 'image_url' || part['type'] === 'video_url' ? mediaUrlFromPart(part) : undefined;
    if (engineRef !== undefined) {
      media.push(toolMediaRef({
        kind: engineRef.kind,
        url: engineRef.url,
        mime: mimeFromDataUrl(engineRef.url),
      }, pending?.kind === engineRef.kind ? pending.path : undefined));
      pending = undefined;
      continue;
    }
    if (part['type'] === 'image' || part['type'] === 'video') {
      const source = part['source'];
      if (typeof source === 'object' && source !== null) {
        media.push(toolMediaRef(
          refFromSource(part['type'], source as Extract<ContentPart, { type: 'image' }>['source']),
          pending?.kind === part['type'] ? pending.path : undefined,
        ));
        pending = undefined;
      }
    }
  }
  if (media.length === 0) return undefined;
  return { text: texts.join('\n'), media };
}

// ---------------------------------------------------------------------------
// File link resolution + preview classification
// ---------------------------------------------------------------------------

const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_ROOTED_RE = /^\/[A-Za-z]:[\\/]/;
const UNC_RE = /^\\\\/;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
const EXTERNAL_SCHEME_RE = /^(?:https?|ftp|mailto|ms|app|blob|data|javascript|file):/i;
/** Bare or ./ ../-prefixed relative tokens that look like files (have an extension). */
const RELATIVE_FILE_RE = /^\.?\.?[\\/]|^(?:[^/\\]+[/\\])*[^/\\]+\.[A-Za-z0-9]{1,10}(?:$|[^A-Za-z0-9])/u;
const FILE_EXTENSION_RE = /(?:^|[\\/])[^/\\\s.][^/\\\s]*\.[A-Za-z][A-Za-z0-9]{0,9}(?:$|[^A-Za-z0-9])/u;

export interface FileReference {
  readonly path: string;
  /** One-based source position, separate from the filesystem path. */
  readonly line?: number;
  readonly column?: number;
  /** Inclusive one-based end line for a line range citation. */
  readonly endLine?: number;
  /** A Markdown heading fragment, without the leading hash. */
  readonly heading?: string;
  /** The target named a position that could not be represented safely. */
  readonly invalidTarget?: boolean;
}

function isExternalReferenceScheme(path: string): boolean {
  if (!SCHEME_RE.test(path) || WINDOWS_ABS_RE.test(path)) return false;
  if (/^file:\/\//i.test(path)) return false;
  return path.includes('://') || EXTERNAL_SCHEME_RE.test(path);
}

function isFileLookingPath(path: string): boolean {
  return /^file:\/\//i.test(path)
    || WINDOWS_ABS_RE.test(path)
    || UNC_RE.test(path)
    || path.startsWith('/')
    || path.startsWith('./')
    || path.startsWith('../')
    || /[\\/]/u.test(path)
    || RELATIVE_FILE_RE.test(path);
}

function isMarkdownPath(path: string): boolean {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return /\.(?:md|markdown|mdx)$/i.test(base);
}

function decodeReferencePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function positiveReferenceNumber(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function positionReference(
  path: string,
  lineText: string,
  columnText: string | undefined,
  endLineText?: string,
): FileReference {
  const line = positiveReferenceNumber(lineText);
  const column = columnText === undefined ? undefined : positiveReferenceNumber(columnText);
  const endLine = endLineText === undefined ? undefined : positiveReferenceNumber(endLineText);
  if (line === undefined || (columnText !== undefined && column === undefined) ||
      (endLineText !== undefined && (endLine === undefined || endLine < line))) {
    return { path, invalidTarget: true };
  }
  if (endLineText === undefined) return { path, line, column };
  return { path, line, column, endLine };
}

function splitFilePosition(value: string): FileReference {
  if (isExternalReferenceScheme(value)) return { path: value };
  const colonPosition = /^(.*?):(\d+)(?::(\d+))?$/u.exec(value);
  if (colonPosition !== null && isFileLookingPath(colonPosition[1]!)) {
    return positionReference(colonPosition[1]!, colonPosition[2]!, colonPosition[3]);
  }

  const hashIndex = value.indexOf('#');
  if (hashIndex === -1) return { path: value };
  const path = value.slice(0, hashIndex);
  const fragment = value.slice(hashIndex + 1);
  if (!isFileLookingPath(path)) return { path: value };

  const lineRange = /^L(\d+)-L(\d+)$/u.exec(fragment);
  if (lineRange !== null) return positionReference(path, lineRange[1]!, undefined, lineRange[2]!);
  const hashPosition = /^L(\d+)(?:C(\d+))?$/u.exec(fragment);
  if (hashPosition !== null) return positionReference(path, hashPosition[1]!, hashPosition[2]);

  if (isMarkdownPath(path) && fragment !== '') return { path, heading: decodeReferencePart(fragment) };
  if (/^L(?:\d|$)/u.test(fragment)) return { path, invalidTarget: true };
  // A non-Markdown hash is potentially a literal filename character. Keep it
  // intact unless it was an explicit line citation handled above.
  return { path: value };
}

/**
 * Streamdown's sanitize+harden pipeline drops or mangles local-file link
 * targets (`file:` and `C:` protocols are stripped, `./x` is resolved against
 * a dummy origin). Markdown rewrites file-ish link URLs to this sentinel path
 * at the remark layer (where the pristine URL is still available); the anchor
 * component unwraps it back to the original target. See Markdown.tsx.
 */
export const FILE_LINK_SENTINEL = '/__kiki-file/';
export const FILE_TEXT_REFERENCE_SENTINEL = '/__kiki-reference/';

/** True when a markdown link target names a local file (any platform form). */
export function isLocalFileLinkTarget(url: string): boolean {
  const path = splitFilePosition(url).path;
  if (/^file:\/\//i.test(path)) return true;
  if (isExternalReferenceScheme(path)) return false;
  if (WINDOWS_ABS_RE.test(path) || UNC_RE.test(path) || /^\/[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith('/')) return false; // posix absolute passes sanitize untouched
  return RELATIVE_FILE_RE.test(path);
}

/** Wrap a local-file link target in the sentinel, undefined when not a file. */
export function wrapFileLinkTarget(url: string, literalPath = false): string | undefined {
  return isLocalFileLinkTarget(url)
    ? `${literalPath ? FILE_TEXT_REFERENCE_SENTINEL : FILE_LINK_SENTINEL}${encodeURIComponent(url)}`
    : undefined;
}

/** Unwrap a sentinel href back to the original link target. */
export function unwrapFileLinkTarget(href: string): string | undefined {
  const prefix = href.startsWith(FILE_TEXT_REFERENCE_SENTINEL) ? FILE_TEXT_REFERENCE_SENTINEL : FILE_LINK_SENTINEL;
  if (!href.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(href.slice(prefix.length));
  } catch {
    return undefined;
  }
}

const APP_ROUTE_PREFIXES = ['/new', '/s', '/r', '/rooms', '/board', '/cron', '/memory', '/activity', '/personas', '/settings', '/usage', '/capabilities'];

/** Href targets react-router should keep handling (app routes, not files). */
export function isAppRouteHref(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0]!;
  if (path === '/') return true;
  return APP_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function parseFileUrl(value: string): { readonly path: string; readonly suffix: string } | undefined {
  if (!/^file:\/\//i.test(value)) return undefined;
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  const suffixIndex = [hashIndex, queryIndex].filter((index) => index >= 0).toSorted((a, b) => a - b)[0];
  const urlValue = suffixIndex === undefined ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex === undefined ? '' : value.slice(suffixIndex);
  try {
    const url = new URL(urlValue);
    let path = decodeURIComponent(url.pathname);
    // file:///C:/work/x → C:/work/x
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (url.hostname !== '' && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
    return path === '' ? undefined : { path, suffix };
  } catch {
    return undefined;
  }
}

/** Join a workspace cwd with a relative reference, resolving . and .. segments. */
export function joinPath(base: string, relative: string): string {
  const combined = `${base.replace(/[\\/]+$/, '')}/${relative}`.replaceAll('\\', '/');
  const absolute = combined.startsWith('/');
  const unc = combined.startsWith('//');
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > (unc ? 2 : 0) && stack.at(-1) !== '..') stack.pop();
      else if (!absolute) stack.push('..');
      continue;
    }
    stack.push(segment);
  }
  return `${unc ? '//' : absolute ? '/' : ''}${stack.join('/')}`;
}

/**
 * Resolve a markdown link target to an absolute host file path, or undefined
 * when the href is not a file reference (external URL, app route, anchor).
 * Relative references need the session cwd or document directory to anchor against.
 * Use literalPath for prose/inline-code citations: their percent characters are
 * filename bytes, unlike URL-encoded hrefs. Explicit file:// URIs decode once.
 */
export function resolveFileReference(href: string, cwd: string | undefined, literalPath = false): FileReference | undefined {
  const value = href.trim();
  if (value === '' || value.startsWith('#') || value.startsWith('//') || isAppRouteHref(value)) return undefined;
  // Split before URL decoding: %3A and %23 can name literal filename characters.
  let reference = splitFilePosition(value);
  let path = reference.path;
  const fileUrl = parseFileUrl(path);
  if (fileUrl !== undefined) {
    path = fileUrl.path;
    if (fileUrl.suffix !== '') reference = splitFilePosition(`${path}${fileUrl.suffix}`);
  }
  if (isExternalReferenceScheme(path)) return undefined;
  if (fileUrl === undefined && !literalPath) path = decodeReferencePart(path);
  // Only the explicit slash + drive-root form is Windows, not arbitrary POSIX paths.
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (WINDOWS_ABS_RE.test(path) || UNC_RE.test(path)) return { ...reference, path };
  if (path.startsWith('/')) return isAppRouteHref(path) ? undefined : { ...reference, path };
  if (cwd === undefined || cwd.trim() === '' || !RELATIVE_FILE_RE.test(path)) return undefined;
  const base = /^\/[A-Za-z]:[\\/]/.test(cwd) ? cwd.slice(1) : cwd;
  return { ...reference, path: joinPath(base, path) };
}

function codeSpanRanges(text: string): readonly (readonly [number, number])[] {
  const ranges: Array<readonly [number, number]> = [];
  const delimiters = /`+/gu;
  let opening: { readonly start: number; readonly length: number } | undefined;
  for (const match of text.matchAll(delimiters)) {
    const start = match.index ?? 0;
    const length = match[0].length;
    if (opening === undefined) {
      opening = { start, length };
    } else if (length === opening.length) {
      ranges.push([opening.start, start + length]);
      opening = undefined;
    }
  }
  if (opening !== undefined) ranges.push([opening.start, text.length]);
  return ranges;
}

function overlapsCodeSpan(start: number, end: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([spanStart, spanEnd]) => start < spanEnd && end > spanStart);
}

function trimReferencePunctuation(value: string): { readonly start: number; readonly end: number } {
  let start = 0;
  let end = value.length;
  while (start < end && /[<([{"'“‘*_（【]/u.test(value[start]!)) start += 1;
  while (end > start && /[)\]}>.,;:!?"'”’*_，。；：！？、）】]/u.test(value[end - 1]!)) end -= 1;
  return { start, end };
}

function isScannableFileReference(target: string): boolean {
  if (target === '' || target.startsWith('-') || target.includes('@') || target.includes('=')) return false;
  if (target.startsWith('//') || target.startsWith('/') && !WINDOWS_ABS_RE.test(target) && !WINDOWS_ROOTED_RE.test(target)) return false;
  if (isExternalReferenceScheme(target)) return false;
  const path = splitFilePosition(target).path;
  if (isExternalReferenceScheme(path)) return false;
  return FILE_EXTENSION_RE.test(path);
}

/**
 * Find file-looking references in Markdown plain prose without parsing links or
 * inline code. Returned offsets are JavaScript string offsets and target keeps
 * the original spelling for the resolver to interpret later.
 */
export function findFileReferences(text: string): readonly { start: number; end: number; target: string }[] {
  const references: Array<{ start: number; end: number; target: string }> = [];
  const codeSpans = codeSpanRanges(text);
  const tokens = /[^\s<>"'()`\u005B\u005D{},;!?]+/gu;
  for (const token of text.matchAll(tokens)) {
    const tokenStart = token.index ?? 0;
    const tokenText = token[0];
    const trimmed = trimReferencePunctuation(tokenText);
    const start = tokenStart + trimmed.start;
    const end = tokenStart + trimmed.end;
    if (start >= end || overlapsCodeSpan(start, end, codeSpans)) continue;
    const target = text.slice(start, end);
    if (!isScannableFileReference(target)) continue;
    references.push({ start, end, target });
  }
  return references;
}

/** Path-only compatibility helper for filesystem operations. */
export function resolveFileHref(href: string, cwd: string | undefined): string | undefined {
  return resolveFileReference(href, cwd)?.path;
}

export type PreviewKind = 'image' | 'markdown' | 'text' | 'video' | 'pdf' | 'office' | 'binary';
export type DocumentPreviewFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
const PDF_EXTS = new Set(['pdf']);
const OFFICE_EXTS = new Set(['docx', 'xlsx', 'pptx']);
// Common video containers. Playback still depends on the codecs the runtime's
// HTML5 stack ships; an unplayable one degrades to the download fallback.
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'mpg', 'mpeg', '3gp', 'ogv']);
const TEXT_EXTS = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'jsonc', 'jsonl', 'xml', 'yml', 'yaml', 'toml',
  'ini', 'cfg', 'conf', 'env', 'properties', 'lock',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'swift', 'kt', 'kts', 'm', 'mm', 'php', 'pl', 'pm', 'r', 'lua', 'sql', 'graphql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'dockerfile', 'makefile', 'cmake', 'mk', 'gradle',
  'gitignore', 'gitattributes', 'editorconfig', 'npmrc', 'nvmrc',
]);

export function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function extOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // Extension-less (or dotfile) known filenames classify by their whole name.
    const lower = base.toLowerCase().replace(/^\.+/, '');
    return TEXT_EXTS.has(lower) ? lower : '';
  }
  return base.slice(dot + 1).toLowerCase();
}

/** Route a path to its preview renderer by extension. */
export function previewKindOf(path: string): PreviewKind {
  const ext = extOf(path);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (OFFICE_EXTS.has(ext)) return 'office';
  // Extension-less files are usually scripts/config; the text view degrades
  // gracefully on the rare binary one.
  if (ext === '') return 'text';
  return 'binary';
}

export function documentPreviewFormatOf(path: string): DocumentPreviewFormat | undefined {
  const ext = extOf(path);
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (OFFICE_EXTS.has(ext)) return ext as Exclude<DocumentPreviewFormat, 'pdf'>;
  return undefined;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
