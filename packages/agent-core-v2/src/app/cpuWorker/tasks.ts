import type { MessagePort } from 'node:worker_threads';
import { decodeImageVerdict } from '#/agent/media/imageDecode';
import { projectWireInput } from './wireTask';

export type CpuOperation =
  | { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | { readonly type: 'wire.context'; readonly input: MessagePort; readonly scope: string; readonly key: string };

export async function executeCpuOperation(operation: CpuOperation): Promise<unknown> {
  switch (operation.type) {
    case 'image.decode': return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType);
    case 'wire.context': return projectWireInput(operation.input, operation.scope, operation.key);
    default: throw new TypeError('Unknown CPU operation');
  }
}
