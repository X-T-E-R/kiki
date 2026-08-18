/**
 * Media helpers for the transcript: structured refs for image/video/file
 * content parts (replacing the old `[image]` placeholder flattening), tool
 * result media extraction (ReadMediaFile-style engine part arrays), and the
 * local-file link resolution behind clickable file paths + previews.
 *
 * Wire facts (packages/protocol/src/message.ts, kap-server messageProjection):
 *   - message image/video parts carry `source: { kind: 'url' | 'base64' | 'file' }`;
 *     base64 data is bare (no data-URL prefix), url may itself be a data: URI.
 *   - file parts are daemon upload references (file_id + name + size), with no
 *     inline bytes and no download endpoint — they render as chips.
 *   - tool results with media keep the raw engine part array as `output`:
 *     `[{ type: 'text', text: '<image path="/abs/x.png">' },
 *       { type: 'image_url', imageUrl: { url: 'data:…' } }, …]`.
 */

import type { Message } from '@moonshot-ai/protocol';

/** A renderable (or at least describable) media reference from a message part. */
export interface MediaRef {
  readonly kind: 'image' | 'video' | 'file';
  /** Ready-to-use URL: a data: URI, blob: URL, or remote http(s) URL. */
  readonly url?: string;
  /** Absolute host path, when the part references a file on disk. */
  readonly path?: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size?: number;
  /** Daemon upload id — the GUI has no fetch endpoint for these. */
  readonly fileId?: string;
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
      return { kind, url: source.url, mime: mimeFromDataUrl(source.url) };
    case 'file':
      return { kind, fileId: source.file_id };
  }
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
  /** Text parts joined, with `<image …>` / `</image>` wrapper tags stripped. */
  readonly text: string;
  readonly media: readonly MediaRef[];
}

const IMAGE_OPEN_TAG_RE = /<image\b[^>]*>/i;
const IMAGE_PATH_RE = /\bpath="([^"]*)"/i;
const IMAGE_ANY_TAG_RE = /<\/?image\b[^>]*>/gi;

function engineMediaUrl(part: Record<string, unknown>): { url: string; kind: 'image' | 'video' } | undefined {
  for (const [type, keys] of [
    ['image_url', ['imageUrl', 'image_url']],
    ['video_url', ['videoUrl', 'video_url']],
  ] as const) {
    if (part['type'] !== type) continue;
    for (const key of keys) {
      const container = part[key];
      if (typeof container === 'object' && container !== null) {
        const url = (container as { url?: unknown }).url;
        if (typeof url === 'string' && url !== '') {
          return { url, kind: type === 'image_url' ? 'image' : 'video' };
        }
      }
    }
  }
  return undefined;
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
  let pendingPath: string | undefined;
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const part = item as Record<string, unknown>;
    if (part['type'] === 'text') {
      const text = part['text'];
      if (typeof text !== 'string') continue;
      if (IMAGE_OPEN_TAG_RE.test(text)) {
        pendingPath = IMAGE_PATH_RE.exec(text)?.[1] ?? pendingPath;
      }
      const cleaned = text.replaceAll(IMAGE_ANY_TAG_RE, '').trim();
      if (cleaned !== '') texts.push(cleaned);
      continue;
    }
    const engineRef = engineMediaUrl(part);
    if (engineRef !== undefined) {
      media.push({
        kind: engineRef.kind,
        url: engineRef.url,
        path: pendingPath,
        mime: mimeFromDataUrl(engineRef.url),
      });
      pendingPath = undefined;
      continue;
    }
    if (part['type'] === 'image' || part['type'] === 'video') {
      const source = part['source'];
      if (typeof source === 'object' && source !== null) {
        media.push({
          ...refFromSource(
            part['type'],
            source as Extract<ContentPart, { type: 'image' }>['source'],
          ),
          path: pendingPath,
        });
        pendingPath = undefined;
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
const UNC_RE = /^\\\\/;
const SCHEME_RE = /^[a-z][a-z\d+.-]*:/i;
/** Bare or ./ ../-prefixed relative tokens that look like files (have an extension). */
const RELATIVE_FILE_RE = /^\.?\.?\/|^(?:[^\s/]+\/)*[^\s/]+\.[A-Za-z0-9]{1,10}$/;

/**
 * Streamdown's sanitize+harden pipeline drops or mangles local-file link
 * targets (`file:` and `C:` protocols are stripped, `./x` is resolved against
 * a dummy origin). Markdown rewrites file-ish link URLs to this sentinel path
 * at the remark layer (where the pristine URL is still available); the anchor
 * component unwraps it back to the original target. See Markdown.tsx.
 */
export const FILE_LINK_SENTINEL = '/__kiki-file/';

/** True when a markdown link target names a local file (any platform form). */
export function isLocalFileLinkTarget(url: string): boolean {
  if (SCHEME_RE.test(url) && !WINDOWS_ABS_RE.test(url)) return /^file:\/\//i.test(url);
  if (WINDOWS_ABS_RE.test(url) || UNC_RE.test(url)) return true;
  if (url.startsWith('/')) return false; // posix absolute passes sanitize untouched
  return RELATIVE_FILE_RE.test(url);
}

/** Wrap a local-file link target in the sentinel, undefined when not a file. */
export function wrapFileLinkTarget(url: string): string | undefined {
  return isLocalFileLinkTarget(url)
    ? `${FILE_LINK_SENTINEL}${encodeURIComponent(url)}`
    : undefined;
}

/** Unwrap a sentinel href back to the original link target. */
export function unwrapFileLinkTarget(href: string): string | undefined {
  if (!href.startsWith(FILE_LINK_SENTINEL)) return undefined;
  try {
    return decodeURIComponent(href.slice(FILE_LINK_SENTINEL.length));
  } catch {
    return undefined;
  }
}

const APP_ROUTE_PREFIXES = ['/new', '/s', '/settings', '/usage', '/capabilities'];

/** Href targets react-router should keep handling (app routes, not files). */
export function isAppRouteHref(href: string): boolean {
  if (href === '/') return true;
  return APP_ROUTE_PREFIXES.some((prefix) => href === prefix || href.startsWith(`${prefix}/`));
}

function parseFileUrl(value: string): string | undefined {
  if (!/^file:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    let path = decodeURIComponent(url.pathname);
    // file:///C:/work/x → C:/work/x
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (url.hostname !== '' && url.hostname !== 'localhost') path = `//${url.hostname}${path}`;
    return path === '' ? undefined : path;
  } catch {
    return undefined;
  }
}

/** Join a workspace cwd with a relative reference, resolving . and .. segments. */
export function joinPath(base: string, relative: string): string {
  const combined = `${base.replace(/[\\/]+$/, '')}/${relative}`.replaceAll('\\', '/');
  const absolute = combined.startsWith('/');
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0 && stack.at(-1) !== '..') stack.pop();
      else if (!absolute) stack.push('..');
      continue;
    }
    stack.push(segment);
  }
  return `${absolute ? '/' : ''}${stack.join('/')}`;
}

/**
 * Resolve a markdown link target to an absolute host file path, or undefined
 * when the href is not a file reference (external URL, app route, anchor).
 * Relative references need the session cwd to anchor against.
 */
export function resolveFileHref(href: string, cwd: string | undefined): string | undefined {
  const value = href.trim();
  if (value === '') return undefined;
  const fileUrl = parseFileUrl(value);
  if (fileUrl !== undefined) return fileUrl;
  // Windows drive / UNC paths must win over the scheme check ('C:' looks like
  // a scheme otherwise).
  if (WINDOWS_ABS_RE.test(value) || UNC_RE.test(value)) return value;
  // Any other explicit scheme (http:, mailto:, ms:) is not a local file.
  if (SCHEME_RE.test(value)) return undefined;
  if (value.startsWith('/')) return isAppRouteHref(value) ? undefined : value;
  if (value.startsWith('#')) return undefined;
  if (cwd === undefined || cwd.trim() === '') return undefined;
  if (!RELATIVE_FILE_RE.test(value)) return undefined;
  return joinPath(cwd, value);
}

export type PreviewKind = 'image' | 'markdown' | 'text' | 'binary';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
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
  // Extension-less files are usually scripts/config; the text view degrades
  // gracefully on the rare binary one.
  if (ext === '') return 'text';
  return 'binary';
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
