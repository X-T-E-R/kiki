import { createHash } from 'node:crypto';

import type { ContentPart, Message } from '#/kosong/contract/message';

import type { MediaStripSnapshot } from './contextProjector';

export const MEDIA_DEGRADE_KEEP_RECENT = 2;

const MEDIA_DEGRADED_PLACEHOLDERS = {
  image_url:
    '[image omitted: dropped to fit the provider request size limit; re-read the file to view it]',
  audio_url:
    '[audio omitted: dropped to fit the provider request size limit; re-read the file to hear it]',
  video_url:
    '[video omitted: dropped to fit the provider request size limit; re-read the file to view it]',
} as const;

export const MEDIA_STRIPPED_PLACEHOLDERS = {
  image_url:
    '[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
  audio_url:
    '[audio omitted for provider compatibility; re-read the file to hear it]',
  video_url:
    '[video omitted for provider compatibility; re-read the file to view it]',
} as const;

type MediaPlaceholderSet = typeof MEDIA_DEGRADED_PLACEHOLDERS | typeof MEDIA_STRIPPED_PLACEHOLDERS;

type DegradableMediaPart = Extract<
  ContentPart,
  { readonly type: keyof MediaPlaceholderSet }
>;

interface MediaContainer {
  readonly url: string;
  readonly id?: string;
}

interface MediaStripSnapshotData {
  readonly keys: ReadonlySet<string>;
}

type MediaContainerKeyCache = Partial<Record<DegradableMediaPart['type'], string>>;

const MEDIA_CONTAINER_KEY_CACHE = new WeakMap<MediaContainer, MediaContainerKeyCache>();

function isDegradableMediaPart(
  part: ContentPart,
): part is DegradableMediaPart {
  return part.type in MEDIA_DEGRADED_PLACEHOLDERS;
}

function mediaContainer(part: DegradableMediaPart): MediaContainer {
  if (part.type === 'image_url') return part.imageUrl;
  if (part.type === 'audio_url') return part.audioUrl;
  return part.videoUrl;
}

function mediaStripKey(part: DegradableMediaPart): string {
  const container = mediaContainer(part);
  let cache = MEDIA_CONTAINER_KEY_CACHE.get(container);
  const cached = cache?.[part.type];
  if (cached !== undefined) return cached;

  const key = createHash('sha256')
    .update(part.type)
    .update('\0')
    .update(container.id ?? '')
    .update('\0')
    .update(container.url)
    .digest('hex');
  if (cache === undefined) {
    cache = {};
    MEDIA_CONTAINER_KEY_CACHE.set(container, cache);
  }
  cache[part.type] = key;
  return key;
}

function mediaStripSnapshotKeys(snapshot: MediaStripSnapshot): ReadonlySet<string> {
  return (snapshot as unknown as MediaStripSnapshotData).keys;
}

export function captureMediaStripSnapshot(
  messages: readonly Message[],
): MediaStripSnapshot {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) keys.add(mediaStripKey(part));
    }
  }
  return Object.freeze({ keys }) as unknown as MediaStripSnapshot;
}

export function stripMediaPartsBySnapshot(
  messages: readonly Message[],
  snapshot: MediaStripSnapshot,
): readonly Message[] {
  const keys = mediaStripSnapshotKeys(snapshot);
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !keys.has(mediaStripKey(part))) return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: MEDIA_STRIPPED_PLACEHOLDERS[part.type] };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function omitUnsupportedAudio(messages: readonly Message[]): readonly Message[] {
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (part.type !== 'audio_url') return part;
      changed = true;
      messageChanged = true;
      return { type: 'text', text: MEDIA_STRIPPED_PLACEHOLDERS.audio_url };
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function degradeOlderMediaParts(
  messages: readonly Message[],
  keepRecent: number,
  placeholders: MediaPlaceholderSet = MEDIA_DEGRADED_PLACEHOLDERS,
): readonly Message[] {
  const mediaCount = messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, mediaCount - keepRecent);
  if (toDegrade === 0) return messages;

  return messages.map((message) => {
    if (toDegrade === 0 || !message.content.some(isDegradableMediaPart)) return message;
    const content = message.content.map((part): ContentPart => {
      if (toDegrade === 0 || !isDegradableMediaPart(part)) return part;
      toDegrade -= 1;
      return { type: 'text', text: placeholders[part.type] };
    });
    return { ...message, content };
  });
}

type HeavyMediaPart = Extract<ContentPart, { readonly type: 'video_url' | 'audio_url' }>;

const HEAVY_MEDIA_OPEN_TAG_RE = /^<(video|audio)\s+path="([^"]+)">$/u;

function isHeavyMediaPart(part: ContentPart): part is HeavyMediaPart {
  return part.type === 'video_url' || part.type === 'audio_url';
}

function heavyMediaHintPath(
  content: readonly ContentPart[],
  index: number,
  part: HeavyMediaPart,
): string | undefined {
  const prev = index > 0 ? content[index - 1] : undefined;
  if (prev?.type === 'text') {
    const match = HEAVY_MEDIA_OPEN_TAG_RE.exec(prev.text.trim());
    if (match !== null) {
      const expectedKind = part.type === 'video_url' ? 'video' : 'audio';
      if (match[1] === expectedKind && match[2] !== undefined && match[2].length > 0) {
        return match[2];
      }
    }
  }
  if (part.type === 'audio_url' && part.audioUrl.name !== undefined && part.audioUrl.name.length > 0) {
    return part.audioUrl.name;
  }
  return undefined;
}

function staleHeavyMediaPlaceholder(
  content: readonly ContentPart[],
  index: number,
  part: HeavyMediaPart,
): string {
  const kind = part.type === 'video_url' ? 'video' : 'audio';
  const path = heavyMediaHintPath(content, index, part);
  if (path !== undefined) {
    return `[${kind} omitted from older turn to save bandwidth (path: ${path}); call ReadMediaFile again if you need to re-inspect it]`;
  }
  return `[${kind} omitted from older turn to save bandwidth; call ReadMediaFile again if you need to re-inspect it]`;
}

export function degradeOlderAudioVideoParts(
  messages: readonly Message[],
  keepRecent: number = MEDIA_DEGRADE_KEEP_RECENT,
): readonly Message[] {
  const heavyCount = messages.reduce(
    (count, message) => count + message.content.filter(isHeavyMediaPart).length,
    0,
  );
  let toDegrade = Math.max(0, heavyCount - keepRecent);
  if (toDegrade === 0) return messages;

  return messages.map((message) => {
    if (toDegrade === 0 || !message.content.some(isHeavyMediaPart)) return message;
    const content = message.content.map((part, index): ContentPart => {
      if (toDegrade === 0 || !isHeavyMediaPart(part)) return part;
      toDegrade -= 1;
      return { type: 'text', text: staleHeavyMediaPlaceholder(message.content, index, part) };
    });
    return { ...message, content };
  });
}
