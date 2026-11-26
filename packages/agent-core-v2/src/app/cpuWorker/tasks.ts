import type { MessagePort } from 'node:worker_threads';
import { workspacePathInventory, workspacePathEntry, workspacePathFilter, workspacePathFilterPacked } from '#/os/backends/node-local/workspacePathInventory';
import { executeWorkspaceTrigram, type WorkspaceTrigramOperation } from '#/os/backends/node-local/workspaceTrigramStore';
import { decodeImageVerdict } from '#/agent/media/imageDecode';
import type {
  AvatarNormalizeWorkerInput,
  ImageCompressWorkerInput,
  ImageCropWorkerInput,
  ImageDimensionsWorkerInput,
  ImageToPngWorkerInput,
} from '#/agent/media/image-compress';
import { LocalLineReader, type LineRangeOptions, type TailRangeOptions } from '#/os/backends/node-local/lineReader';
import { decodeWireInput, projectWireInput } from './wireTask';
import {
  executeWireParseJournalSlice,
  executeWireParseJournalStream,
  type WireParseJournalSliceOperation,
  type WireParseJournalStreamOperation,
} from './wireJournalTask';
import { executeWireGoalScan, type WireGoalScanOperation } from './goalScanTask';
import { parseThreadTurnRecord } from '#/app/threadCommunication/threadTurnRecord';
import { readCheckpointStatesFromPath } from '#/session/replayCheckpointArchive';
import {
  REPLAY_ABI_VERSION,
  type ReplayCheckpointWire,
} from '#/state/replayCheckpointCodec';

export interface FileLineRangeOperation {
  readonly type: 'file.lineRange';
  readonly path: string;
  readonly options: Omit<LineRangeOptions, 'signal'>;
}

export type CpuOperation =
  | { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | ({ readonly type: 'image.compress' } & ImageCompressWorkerInput)
  | ({ readonly type: 'image.crop' } & ImageCropWorkerInput)
  | ({ readonly type: 'image.normalizeAvatar' } & AvatarNormalizeWorkerInput)
  | ({ readonly type: 'image.dimensions' } & ImageDimensionsWorkerInput)
  | ({ readonly type: 'image.toPng' } & ImageToPngWorkerInput)
  | { readonly type: 'wire.context'; readonly input: MessagePort; readonly scope: string; readonly key: string; readonly omitTranscript?: boolean }
  | WireParseJournalSliceOperation
  | WireParseJournalStreamOperation
  | { readonly type: 'wire.threadTurnRecord'; readonly input: MessagePort }
  | WireGoalScanOperation
  | { readonly type: 'checkpoint.read'; readonly path: string; readonly names: readonly string[] }
  | FileLineRangeOperation
  | { readonly type: 'file.tailRange'; readonly path: string; readonly options: Omit<TailRangeOptions, 'signal'> }
  | { readonly type: 'workspace.pathFilter'; readonly root: string; readonly paths: readonly string[] }
  | { readonly type: 'workspace.pathFilterPacked'; readonly root: string; readonly pathsText: string }
  | { readonly type: 'workspace.path'; readonly root: string; readonly path: string }
  | { readonly type: 'workspace.paths'; readonly root: string; readonly limit: number }
  | WorkspaceTrigramOperation;

const lineReader = new LocalLineReader();

async function readCheckpointStatesFromFile(
  filePath: string,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly wire: ReplayCheckpointWire; readonly states: ReadonlyMap<string, unknown> } | undefined> {
  return readCheckpointStatesFromPath(filePath, new Set(names), REPLAY_ABI_VERSION, signal);
}

export async function executeCpuOperation(operation: CpuOperation, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  switch (operation.type) {
    case 'workspace.pathFilter': return workspacePathFilter(operation.root, operation.paths, signal);
    case 'workspace.pathFilterPacked': return workspacePathFilterPacked(operation.root, operation.pathsText, signal);
    case 'workspace.path': return workspacePathEntry(operation.root, operation.path, signal);
    case 'workspace.paths': return workspacePathInventory(operation.root, operation.limit, signal);
    case 'workspace.trigram.begin':
    case 'workspace.trigram.update':
    case 'workspace.trigram.finish':
    case 'workspace.trigram.query': return executeWorkspaceTrigram(operation, signal);
    case 'image.decode': return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType, signal);
    case 'image.compress': {
      const { executeImageCompress } = await import('#/agent/media/image-compress');
      signal?.throwIfAborted();
      return executeImageCompress(operation, signal);
    }
    case 'image.crop': {
      const { executeImageCrop } = await import('#/agent/media/image-compress');
      signal?.throwIfAborted();
      return executeImageCrop(operation, signal);
    }
    case 'image.normalizeAvatar': {
      const { executeAvatarNormalize } = await import('#/agent/media/image-compress');
      signal?.throwIfAborted();
      return executeAvatarNormalize(operation, signal);
    }
    case 'image.dimensions': {
      const { executeImageDimensions } = await import('#/agent/media/image-compress');
      signal?.throwIfAborted();
      return executeImageDimensions(operation, signal);
    }
    case 'image.toPng': {
      const { executeImageToPng } = await import('#/agent/media/image-compress');
      signal?.throwIfAborted();
      return executeImageToPng(operation, signal);
    }
    case 'wire.context': return projectWireInput(operation.input, operation.scope, operation.key, operation.omitTranscript === true, signal);
    case 'wire.parseJournalSlice': return executeWireParseJournalSlice(operation, signal);
    case 'wire.parseJournalStream': return executeWireParseJournalStream(operation, signal);
    case 'wire.goalScan': return executeWireGoalScan(operation, signal);
    case 'checkpoint.read': return readCheckpointStatesFromFile(operation.path, operation.names, signal);
    case 'wire.threadTurnRecord': {
      const chunks: string[] = [];
      for await (const chunk of decodeWireInput(operation.input, signal)) {
        signal?.throwIfAborted();
        chunks.push(chunk);
      }
      signal?.throwIfAborted();
      return parseThreadTurnRecord(chunks.join(''));
    }
    case 'file.tailRange': return lineReader.readTailPage(operation.path, { ...operation.options, signal });
    case 'file.lineRange': {
      const lines: string[] = [];
      for await (const line of lineReader.readLineRange(operation.path, { ...operation.options, signal })) {
        signal?.throwIfAborted();
        lines.push(line);
      }
      return lines;
    }
    default: throw new TypeError('Unknown CPU operation');
  }
}
