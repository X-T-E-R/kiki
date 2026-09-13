import type { MessageContent } from '@kiki/protocol';

import { MEDIA_FILE_REF_MIN_REMAINING_MS } from '#/tui/constant/media';
import type {
  ImageAttachmentStore,
  MediaAttachment,
} from '#/tui/utils/image-attachment-store';

export interface DaemonFileAttachment {
  readonly id: number;
  fileId: string | undefined;
  expiresAt: number | undefined;
  readonly sourcePath: string;
  readonly name: string;
  readonly mediaType: string;
  size: number;
  readonly placeholder: string;
}

export interface DaemonAttachmentRefresher {
  refreshMedia(attachment: MediaAttachment): Promise<void>;
  refreshFile(attachment: DaemonFileAttachment): Promise<void>;
}

export interface PreparedDaemonPrompt {
  readonly content: MessageContent[];
  readonly engineContent: Array<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image_url'; readonly imageUrl: { readonly url: string } }
    | { readonly type: 'video_url'; readonly videoUrl: { readonly url: string } }
  >;
  readonly hasFileAttachment: boolean;
  readonly imageAttachmentIds: readonly number[];
  readonly fileAttachmentIds: readonly number[];
  readonly mediaUploadIds: readonly string[];
  readonly fileUploadIds: readonly string[];
  readonly uploadExpiresAt: readonly number[];
}

const ATTACHMENT_PATTERN =
  /\[(image|video) #(\d+) (?:(?:\(\d+×\d+\))|[^\]]+)\]|\[file #(\d+) ([^\]]+)\]/gu;

interface MediaSelection {
  readonly kind: 'media';
  readonly attachment: MediaAttachment;
}

interface FileSelection {
  readonly kind: 'file';
  readonly attachment: DaemonFileAttachment;
}

type AttachmentSelection = MediaSelection | FileSelection;
type PromptSegment = { readonly kind: 'text'; readonly text: string } | AttachmentSelection;

export async function prepareDaemonPrompt(
  text: string,
  images: ImageAttachmentStore,
  files: ReadonlyMap<number, DaemonFileAttachment>,
  refresher: DaemonAttachmentRefresher,
  clock: () => number = Date.now,
): Promise<PreparedDaemonPrompt | undefined> {
  const segments: PromptSegment[] = [];
  const selections = new Map<string, AttachmentSelection>();
  let cursor = 0;
  ATTACHMENT_PATTERN.lastIndex = 0;
  for (let match = ATTACHMENT_PATTERN.exec(text); match !== null; match = ATTACHMENT_PATTERN.exec(text)) {
    pushSegmentText(segments, text.slice(cursor, match.index));
    const mediaKind = match[1];
    const mediaId = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
    const fileId = match[3] === undefined ? undefined : Number.parseInt(match[3], 10);
    if (mediaKind !== undefined && mediaId !== undefined) {
      const attachment = images.get(mediaId);
      if (attachment === undefined || attachment.kind !== mediaKind) {
        pushSegmentText(segments, match[0]);
      } else {
        const selection: MediaSelection = { kind: 'media', attachment };
        selections.set(`media:${String(mediaId)}`, selection);
        segments.push(selection);
      }
    } else if (fileId !== undefined) {
      const attachment = files.get(fileId);
      if (attachment === undefined) {
        pushSegmentText(segments, match[0]);
      } else {
        const selection: FileSelection = { kind: 'file', attachment };
        selections.set(`file:${String(fileId)}`, selection);
        segments.push(selection);
      }
    }
    cursor = match.index + match[0].length;
  }
  pushSegmentText(segments, text.slice(cursor));
  if (selections.size === 0) return undefined;

  await Promise.all(
    [...selections.values()].flatMap((selection) =>
      selection.kind === 'media' && selection.attachment.pending !== undefined
        ? [selection.attachment.pending]
        : [],
    ),
  );

  const maxRounds = Math.min(6, selections.size + 2);
  for (let round = 0; round < maxRounds; round += 1) {
    const validationTime = clock();
    const stale = [...selections.values()].filter(
      (selection) => !isFresh(selectionExpiry(selection), validationTime),
    );
    if (stale.length === 0) return buildPreparedPrompt(segments, selections);
    await Promise.all(stale.map((selection) => refreshSelection(selection, refresher)));
  }

  const finalTime = clock();
  const stale = [...selections.values()].filter(
    (selection) => !isFresh(selectionExpiry(selection), finalTime),
  );
  if (stale.length === 0) return buildPreparedPrompt(segments, selections);
  throw new Error(
    `Attachment freshness did not stabilize: ${stale.map(selectionPlaceholder).join(', ')}. Try again.`,
  );
}

function buildPreparedPrompt(
  segments: readonly PromptSegment[],
  selections: ReadonlyMap<string, AttachmentSelection>,
): PreparedDaemonPrompt {
  const content: MessageContent[] = [];
  const engineContent: PreparedDaemonPrompt['engineContent'][number][] = [];
  for (const segment of segments) {
    if (segment.kind === 'text') {
      pushText(content, engineContent, segment.text);
      continue;
    }
    if (segment.kind === 'file') {
      const attachment = segment.attachment;
      content.push({
        type: 'file',
        file_id: attachment.fileId!,
        name: attachment.name,
        media_type: attachment.mediaType,
        size: attachment.size,
      });
      continue;
    }
    const attachment = segment.attachment;
    const fileId = attachment.fileId!;
    const source = { kind: 'file' as const, file_id: fileId };
    const url = `kimi-file://${fileId}`;
    if (attachment.kind === 'image') {
      content.push({ type: 'image', source });
      engineContent.push({ type: 'image_url', imageUrl: { url } });
    } else {
      content.push({ type: 'video', source });
      engineContent.push({ type: 'video_url', videoUrl: { url } });
    }
  }

  const imageAttachmentIds: number[] = [];
  const fileAttachmentIds: number[] = [];
  const mediaUploadIds: string[] = [];
  const fileUploadIds: string[] = [];
  const uploadExpiresAt: number[] = [];
  for (const selection of selections.values()) {
    if (selection.kind === 'media') {
      imageAttachmentIds.push(selection.attachment.id);
      mediaUploadIds.push(selection.attachment.fileId!);
      uploadExpiresAt.push(selection.attachment.fileExpiresAt!);
    } else {
      fileAttachmentIds.push(selection.attachment.id);
      fileUploadIds.push(selection.attachment.fileId!);
      uploadExpiresAt.push(selection.attachment.expiresAt!);
    }
  }
  return {
    content,
    engineContent,
    hasFileAttachment: fileAttachmentIds.length > 0,
    imageAttachmentIds,
    fileAttachmentIds,
    mediaUploadIds,
    fileUploadIds,
    uploadExpiresAt,
  };
}

function refreshSelection(
  selection: AttachmentSelection,
  refresher: DaemonAttachmentRefresher,
): Promise<void> {
  return selection.kind === 'media'
    ? refresher.refreshMedia(selection.attachment)
    : refresher.refreshFile(selection.attachment);
}

function selectionExpiry(selection: AttachmentSelection): number | undefined {
  return selection.kind === 'media'
    ? selection.attachment.fileExpiresAt
    : selection.attachment.expiresAt;
}

function selectionPlaceholder(selection: AttachmentSelection): string {
  return selection.attachment.placeholder;
}

function isFresh(expiresAt: number | undefined, now: number): expiresAt is number {
  return expiresAt !== undefined && expiresAt - now > MEDIA_FILE_REF_MIN_REMAINING_MS;
}

function pushSegmentText(segments: PromptSegment[], text: string): void {
  if (text !== '') segments.push({ kind: 'text', text });
}

function pushText(
  content: MessageContent[],
  engineContent: PreparedDaemonPrompt['engineContent'][number][],
  text: string,
): void {
  if (text === '') return;
  content.push({ type: 'text', text });
  engineContent.push({ type: 'text', text });
}
