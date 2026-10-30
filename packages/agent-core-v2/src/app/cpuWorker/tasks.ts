import type { MessagePort } from 'node:worker_threads';
import { decodeImageVerdict } from '#/agent/media/imageDecode';
import { LocalLineReader, type LineRangeOptions } from '#/os/backends/node-local/lineReader';
import { projectWireInput } from './wireTask';

export interface FileLineRangeOperation {
  readonly type: 'file.lineRange';
  readonly path: string;
  readonly options: Omit<LineRangeOptions, 'signal'>;
}

export type CpuOperation =
  | { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | { readonly type: 'wire.context'; readonly input: MessagePort; readonly scope: string; readonly key: string }
  | FileLineRangeOperation;

const lineReader = new LocalLineReader();

export async function executeCpuOperation(operation: CpuOperation): Promise<unknown> {
  switch (operation.type) {
    case 'image.decode': return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType);
    case 'wire.context': return projectWireInput(operation.input, operation.scope, operation.key);
    case 'file.lineRange': {
      const lines: string[] = [];
      for await (const line of lineReader.readLineRange(operation.path, operation.options)) lines.push(line);
      return lines;
    }
    default: throw new TypeError('Unknown CPU operation');
  }
}
