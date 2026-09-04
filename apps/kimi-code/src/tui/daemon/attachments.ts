import type { MessageContent } from '@moonshot-ai/protocol';

import type { ImageAttachmentStore } from '#/tui/utils/image-attachment-store';

export interface DaemonFileAttachment {
  readonly id: number;
  readonly fileId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly placeholder: string;
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
}

const ATTACHMENT_PATTERN =
  /\[(image|video) #(\d+) (?:(?:\(\d+×\d+\))|[^\]]+)\]|\[file #(\d+) ([^\]]+)\]/gu;

export async function prepareDaemonPrompt(
  text: string,
  images: ImageAttachmentStore,
  files: ReadonlyMap<number, DaemonFileAttachment>,
): Promise<PreparedDaemonPrompt | undefined> {
  const content: MessageContent[] = [];
  const engineContent: PreparedDaemonPrompt['engineContent'][number][] = [];
  let cursor = 0;
  let matched = false;
  let hasFileAttachment = false;
  const imageAttachmentIds: number[] = [];
  const fileAttachmentIds: number[] = [];
  const mediaUploadIds: string[] = [];
  const fileUploadIds: string[] = [];
  ATTACHMENT_PATTERN.lastIndex = 0;
  for (let match = ATTACHMENT_PATTERN.exec(text); match !== null; match = ATTACHMENT_PATTERN.exec(text)) {
    const before = text.slice(cursor, match.index);
    pushText(content, engineContent, before);
    const mediaKind = match[1];
    const mediaId = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
    const fileId = match[3] === undefined ? undefined : Number.parseInt(match[3], 10);
    if (mediaKind !== undefined && mediaId !== undefined) {
      const attachment = images.get(mediaId);
      if (attachment === undefined || attachment.kind !== mediaKind) {
        pushText(content, engineContent, match[0]);
      } else {
        await attachment.pending;
        if (attachment.fileId === undefined) throw new Error(`Attachment upload failed: ${attachment.placeholder}`);
        const source = { kind: 'file' as const, file_id: attachment.fileId };
        const url = `kimi-file://${attachment.fileId}`;
        if (attachment.kind === 'image') {
          content.push({ type: 'image', source });
          engineContent.push({ type: 'image_url', imageUrl: { url } });
        } else {
          content.push({ type: 'video', source });
          engineContent.push({ type: 'video_url', videoUrl: { url } });
        }
        imageAttachmentIds.push(mediaId);
        mediaUploadIds.push(attachment.fileId);
        matched = true;
      }
    } else if (fileId !== undefined) {
      const attachment = files.get(fileId);
      if (attachment === undefined) {
        pushText(content, engineContent, match[0]);
      } else {
        content.push({
          type: 'file',
          file_id: attachment.fileId,
          name: attachment.name,
          media_type: attachment.mediaType,
          size: attachment.size,
        });
        fileAttachmentIds.push(fileId);
        fileUploadIds.push(attachment.fileId);
        hasFileAttachment = true;
        matched = true;
      }
    }
    cursor = match.index + match[0].length;
  }
  pushText(content, engineContent, text.slice(cursor));
  return matched
    ? {
        content,
        engineContent,
        hasFileAttachment,
        imageAttachmentIds,
        fileAttachmentIds,
        mediaUploadIds,
        fileUploadIds,
      }
    : undefined;
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
