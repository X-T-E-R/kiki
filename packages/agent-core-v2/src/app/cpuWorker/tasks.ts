import type { MessagePort } from 'node:worker_threads';
import { decodeImageVerdict } from '#/agent/media/imageDecode';
import { LocalLineReader, type LineRangeOptions } from '#/os/backends/node-local/lineReader';
import { decodeWireInput, projectWireInput } from './wireTask';
import { parseThreadTurnRecord } from '#/app/threadCommunication/threadTurnRecord';

export interface FileLineRangeOperation {
  readonly type: 'file.lineRange';
  readonly path: string;
  readonly options: Omit<LineRangeOptions, 'signal'>;
}

export type CpuOperation =
  | { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | { readonly type: 'wire.context'; readonly input: MessagePort; readonly scope: string; readonly key: string }
  | { readonly type: 'wire.threadTurnRecord'; readonly input: MessagePort }
  | FileLineRangeOperation;

const lineReader = new LocalLineReader();

export async function executeCpuOperation(operation: CpuOperation): Promise<unknown> {
  switch (operation.type) {
    case 'image.decode': return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType);
    case 'wire.context': return projectWireInput(operation.input, operation.scope, operation.key);
    case 'wire.threadTurnRecord': {
      const chunks: string[] = [];
      for await (const chunk of decodeWireInput(operation.input)) chunks.push(chunk);
      return parseThreadTurnRecord(chunks.join(''));
    }
    case 'file.lineRange': {
      const lines: string[] = [];
      for await (const line of lineReader.readLineRange(operation.path, operation.options)) lines.push(line);
      return lines;
    }
    default: throw new TypeError('Unknown CPU operation');
  }
}
