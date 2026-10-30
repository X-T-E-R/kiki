import { decodeImageVerdict } from '#/agent/media/imageDecode';

export type CpuOperation = { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string };

export async function executeCpuOperation(operation: CpuOperation): Promise<unknown> {
  if (operation.type === 'image.decode') return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType);
  throw new TypeError('Unknown CPU operation');
}
