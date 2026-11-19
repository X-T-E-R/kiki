import { basename, dirname } from 'node:path';
import type { MessagePort } from 'node:worker_threads';
import { workspacePathInventory, workspacePathEntry, workspacePathFilter } from '#/os/backends/node-local/workspacePathInventory';
import { executeWorkspaceTrigram, type WorkspaceTrigramOperation } from '#/os/backends/node-local/workspaceTrigramStore';
import { decodeImageVerdict } from '#/agent/media/imageDecode';
import { LocalLineReader, type LineRangeOptions, type TailRangeOptions } from '#/os/backends/node-local/lineReader';
import { decodeWireInput, projectWireInput } from './wireTask';
import { parseThreadTurnRecord } from '#/app/threadCommunication/threadTurnRecord';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import {
  REPLAY_ABI_VERSION,
  decodeReplayCheckpointStates,
  type ReplayCheckpointGraph,
  type ReplayCheckpointWire,
} from '#/state/replayCheckpointCodec';

export interface FileLineRangeOperation {
  readonly type: 'file.lineRange';
  readonly path: string;
  readonly options: Omit<LineRangeOptions, 'signal'>;
}

export type CpuOperation =
  | { readonly type: 'image.decode'; readonly bytes: ArrayBuffer; readonly mimeType: string }
  | { readonly type: 'wire.context'; readonly input: MessagePort; readonly scope: string; readonly key: string; readonly omitTranscript?: boolean }
  | { readonly type: 'wire.threadTurnRecord'; readonly input: MessagePort }
  | { readonly type: 'checkpoint.read'; readonly path: string; readonly names: readonly string[] }
  | FileLineRangeOperation
  | { readonly type: 'file.tailRange'; readonly path: string; readonly options: Omit<TailRangeOptions, 'signal'> }
  | { readonly type: 'workspace.pathFilter'; readonly root: string; readonly paths: readonly string[] }
  | { readonly type: 'workspace.path'; readonly root: string; readonly path: string }
  | { readonly type: 'workspace.paths'; readonly root: string; readonly limit: number }
  | WorkspaceTrigramOperation;

const lineReader = new LocalLineReader();
const utf8Decoder = new TextDecoder();

async function readCheckpointStatesFromFile(
  filePath: string,
  names: readonly string[],
): Promise<{ readonly wire: ReplayCheckpointWire; readonly states: Map<string, unknown> } | undefined> {
  const bytes = await new FileStorageService(dirname(filePath)).read('', basename(filePath));
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(bytes));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const checkpoint = parsed as {
    readonly format?: unknown;
    readonly replayAbi?: unknown;
    readonly wire?: ReplayCheckpointWire;
    readonly graph?: ReplayCheckpointGraph;
  };
  if (
    checkpoint.format !== 1 ||
    checkpoint.replayAbi !== REPLAY_ABI_VERSION ||
    checkpoint.wire === undefined ||
    checkpoint.graph === undefined
  ) {
    return undefined;
  }
  try {
    return {
      wire: checkpoint.wire,
      states: new Map(decodeReplayCheckpointStates(checkpoint.graph, new Set(names))),
    };
  } catch {
    return undefined;
  }
}

export async function executeCpuOperation(operation: CpuOperation): Promise<unknown> {
  switch (operation.type) {
    case 'workspace.pathFilter': return workspacePathFilter(operation.root, operation.paths);
    case 'workspace.path': return workspacePathEntry(operation.root, operation.path);
    case 'workspace.paths': return workspacePathInventory(operation.root, operation.limit);
    case 'workspace.trigram.begin':
    case 'workspace.trigram.update':
    case 'workspace.trigram.finish':
    case 'workspace.trigram.query': return executeWorkspaceTrigram(operation);
    case 'image.decode': return decodeImageVerdict(new Uint8Array(operation.bytes), operation.mimeType);
    case 'wire.context': return projectWireInput(operation.input, operation.scope, operation.key, operation.omitTranscript === true);
    case 'checkpoint.read': return readCheckpointStatesFromFile(operation.path, operation.names);
    case 'wire.threadTurnRecord': {
      const chunks: string[] = [];
      for await (const chunk of decodeWireInput(operation.input)) chunks.push(chunk);
      return parseThreadTurnRecord(chunks.join(''));
    }
    case 'file.tailRange': return lineReader.readTailPage(operation.path, operation.options);
    case 'file.lineRange': {
      const lines: string[] = [];
      for await (const line of lineReader.readLineRange(operation.path, operation.options)) lines.push(line);
      return lines;
    }
    default: throw new TypeError('Unknown CPU operation');
  }
}
