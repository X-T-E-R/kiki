export type MediaPathTagKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaPathTagMatch {
  readonly kind: MediaPathTagKind;
  readonly path: string;
}

const SINGLE_MEDIA_PATH_TAG_RE =
  /^\s*<(image|video|audio|file)\b[^>]*?\bpath="([^"]*)"[^>]*>(?:<\/\1>)?\s*$/;

/**
 * The whole text is exactly one media path tag (surrounding whitespace
 * tolerated) — the mirror of the engine's `matchSingleMediaPathTag`.
 * Tolerates extra attributes and a missing closing tag, like the engine
 * grammar. Tags embedded in larger user text are NOT matched: stripping
 * there would eat user content.
 */
export function matchMediaPathTagText(text: string): MediaPathTagMatch | undefined {
  const match = SINGLE_MEDIA_PATH_TAG_RE.exec(text);
  if (match === null) return undefined;
  return { kind: match[1] as MediaPathTagKind, path: unescapeMediaAttribute(match[2]!) };
}

function unescapeMediaAttribute(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

const KIMI_FILE_SCHEME = 'kimi-file://';

/** The daemon upload reference behind a `kimi-file://<fileId>` url. */
export interface DaemonFileRef {
  readonly fileId: string;
}

/**
 * Parse a `kimi-file://<fileId>` url — the mirror of the engine's
 * `parseDaemonFileUrl`. A legacy `?path=` query (the retired persisted
 * materialization path) is stripped and ignored.
 */
export function parseDaemonFileRef(url: string): DaemonFileRef | undefined {
  if (!url.startsWith(KIMI_FILE_SCHEME)) return undefined;
  const rest = url.slice(KIMI_FILE_SCHEME.length);
  const queryAt = rest.indexOf('?');
  const fileId = queryAt === -1 ? rest : rest.slice(0, queryAt);
  return fileId.length > 0 ? { fileId } : undefined;
}

/** The daemon upload id behind a `kimi-file://<fileId>` url. */
export function parseDaemonFileRefFileId(url: string): string | undefined {
  return parseDaemonFileRef(url)?.fileId;
}

/**
 * The structural minimum the daemon-ref extraction needs from a content
 * part — the kosong `text` / `image_url` / `video_url` shapes plus anything
 * else.
 */
export interface MediaRefPart {
  readonly type: string;
  readonly text?: string;
  readonly imageUrl?: { readonly url?: string };
  readonly videoUrl?: { readonly url?: string };
}

/**
 * The daemon reference behind a content part, if any — the mirror of the
 * engine's `daemonFileRefFromPart` (keep the two in sync): the kind comes
 * from the part type, the file id from the `kimi-file://` url. This is the
 * single part → ref extraction read models share.
 */
export function daemonFileRefFromPairingPart(
  part: MediaRefPart,
): { readonly kind: 'image' | 'video'; readonly ref: DaemonFileRef } | undefined {
  if (part.type !== 'image_url' && part.type !== 'video_url') return undefined;
  const url = part.type === 'image_url' ? part.imageUrl?.url : part.videoUrl?.url;
  if (typeof url !== 'string') return undefined;
  const ref = parseDaemonFileRef(url);
  if (ref === undefined) return undefined;
  return { kind: part.type === 'image_url' ? 'image' : 'video', ref };
}

export type MediaBlobRef =
  | { readonly kind: 'agent'; readonly agentId: string; readonly hash: string }
  | { readonly kind: 'mime'; readonly mime: string; readonly hash: string };

export function parseMediaBlobRef(url: string): MediaBlobRef | undefined {
  const agent = /^blobref:([A-Za-z0-9][A-Za-z0-9_-]{0,255})[/:]([0-9a-f]{64})$/u.exec(url);
  if (agent !== null) return { kind: 'agent', agentId: agent[1]!, hash: agent[2]! };
  const mime = /^blobref:((?:image|video)\/[A-Za-z0-9.+_*-]+);([0-9a-f]{64})$/u.exec(url);
  return mime === null ? undefined : { kind: 'mime', mime: mime[1]!, hash: mime[2]! };
}

export function mediaUrlFromPart(part: unknown): { readonly kind: 'image' | 'video'; readonly url: string } | undefined {
  if (part === null || typeof part !== 'object' || Array.isArray(part)) return undefined;
  const value = part as Record<string, unknown>;
  for (const kind of ['image', 'video'] as const) {
    if (value['type'] === `${kind}_url`) {
      for (const key of [`${kind}Url`, `${kind}_url`]) {
        const container = value[key] as { url?: unknown } | undefined;
        if (typeof container?.url === 'string' && container.url !== '') return { kind, url: container.url };
      }
    }
    if (value['type'] === kind) {
      const source = value['source'] as { kind?: unknown; url?: unknown; media_type?: unknown; data?: unknown } | undefined;
      if (source?.kind === 'url' && typeof source.url === 'string') return { kind, url: source.url };
      if (source?.kind === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string')
        return { kind, url: `data:${source.media_type};base64,${source.data}` };
    }
  }
  return undefined;
}

/** Preserve an explicitly agent-scoped durable blob URL as the existing session-media file id. */
export function sessionMediaIdFromBlobUrl(url: string): string | undefined {
  const ref = parseMediaBlobRef(url);
  return ref?.kind === 'agent' ? `blobref:${ref.agentId}:${ref.hash}` : undefined;
}
