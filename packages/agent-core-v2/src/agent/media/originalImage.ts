import type { ContentPart } from '#/kosong/contract/message';
import { Error2, ErrorCodes } from '#/errors';
import { detectFileType, MEDIA_SNIFF_BYTES } from './file-type';
import { validateImageDataUrl } from './image-compress';
import { INVALID_IMAGE_DATA_URL_MESSAGE, normalizeImageMime } from './image-format-policy';
import { daemonFileRefFromPart, parseMediaBlobRef } from './mediaRef';

export async function resolveOriginalImagePart(
  part: ContentPart,
  agentId: string,
  readBlob: (hash: string) => Promise<Uint8Array | undefined>,
): Promise<ContentPart | undefined> {
  if (part.type !== 'image_url') return undefined;
  const daemon = daemonFileRefFromPart(part);
  const fileId = part.imageUrl.url.startsWith('blobref:') ? part.imageUrl.url : daemon?.ref.fileId;
  if (fileId === undefined || !fileId.startsWith('blobref:')) return undefined;
  const ref = parseMediaBlobRef(fileId);
  if (ref === undefined || (ref.kind === 'agent' ? ref.agentId !== agentId : !ref.mime.startsWith('image/'))) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'The image attachment blob reference is invalid. Reattach the original image and retry.');
  }
  const bytes = await readBlob(ref.hash);
  if (bytes === undefined) {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'The original image attachment is unavailable. Reattach the original image and retry.');
  }
  const source = Buffer.from(bytes);
  const fileType = detectFileType('image', source.subarray(0, MEDIA_SNIFF_BYTES), 'media');
  if (fileType.kind !== 'image') {
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'The original image attachment is invalid. Reattach the original image and retry.');
  }
  const restoredUrl = `data:${normalizeImageMime(fileType.mimeType)};base64,${source.toString('base64')}`;
  if (await validateImageDataUrl(restoredUrl) === null) throw new Error2(ErrorCodes.REQUEST_INVALID, INVALID_IMAGE_DATA_URL_MESSAGE);
  return { ...part, imageUrl: { ...part.imageUrl, url: restoredUrl } };
}
