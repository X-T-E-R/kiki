import { randomUuid } from '@kiki/session-core/util';
import type {
  BrowserHostAdapter,
  HostNotification,
  HostSelectedFile,
  LocalConnection,
} from './host';
import { bufferedSaveSink } from './saveSink';

interface VscodeApi {
  postMessage(message: unknown): void;
}

interface HostResponse {
  readonly channel: 'kiki.vscode-host.response';
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

interface SelectedFilePayload {
  readonly name: string;
  readonly type: string;
  readonly bytes: Uint8Array | ArrayBuffer | readonly number[];
}

type AcquireVscodeApi = () => VscodeApi;

const INTERACTIVE_DIALOG_METHODS = new Set([
  'file.pick',
  'directory.pick',
  'directory.pickMany',
  'file.save',
  'file.save.open',
]);
const DEFAULT_VSCODE_REQUEST_TIMEOUT_MS = 30_000;

let api: VscodeApi | undefined;
let listenerInstalled = false;
const pending = new Map<
  string,
  {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer?: ReturnType<typeof setTimeout>;
  }
>();

import { isVscodeWebview } from './detect';
export { isVscodeWebview } from './detect';

export function requestVscodeHost<T>(method: string, params: unknown = {}): Promise<T> {
  const vscode = getApi();
  installResponseListener();
  const id = randomUuid();
  return new Promise<T>((resolve, reject) => {
    const timer = INTERACTIVE_DIALOG_METHODS.has(method)
      ? undefined
      : setTimeout(() => {
          if (pending.delete(id)) {
            reject(new Error(`VS Code host request timed out: ${method}`));
          }
        }, DEFAULT_VSCODE_REQUEST_TIMEOUT_MS);
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    vscode.postMessage({ channel: 'kiki.vscode-host.request', id, method, params });
  });
}

export interface VscodeHostAdapter extends BrowserHostAdapter {
  preparePrompt(
    content: string,
    conversationId?: string,
    includeEditorContext?: boolean,
  ): Promise<string>;
  openFile(path: string, line?: number, column?: number): Promise<void>;
  showDiff(originalPath: string, modifiedPath: string, title?: string): Promise<void>;
  openTerminal(cwd?: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export const vscodeHost: VscodeHostAdapter = {
  kind: 'browser',
  connection: {
    discover: () => requestVscodeHost<LocalConnection>('connection.discover'),
  },
  preparePrompt: (content, conversationId, includeEditorContext = true) =>
    requestVscodeHost<string>('editor.preparePrompt', {
      content,
      conversationId,
      includeEditorContext,
    }),
  notify: (options: HostNotification) => requestVscodeHost<void>('window.notify', options),
  isWindowVisibleAndFocused: () => requestVscodeHost<boolean>('window.focused'),
  async saveBlob(blob, filename) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return requestVscodeHost<boolean>('file.save', { filename, bytes });
  },
  async openSaveSink(filename) {
    const result = await requestVscodeHost<{ supported: boolean; sinkId?: string } | null>('file.save.open', { filename });
    if (result === null) return null;
    if (!result.supported) return bufferedSaveSink((blob) => vscodeHost.saveBlob!(blob, filename));
    if (result.sinkId === undefined) throw new Error('The host did not open a save stream');
    const sinkId = result.sinkId;
    let offset = 0;
    let closed = false;
    return {
      streaming: true,
      async write(chunk: Uint8Array) {
        if (closed) throw new Error('The save stream is closed');
        for (let start = 0; start < chunk.byteLength; start += 64 * 1024) {
          const bytes = chunk.slice(start, Math.min(chunk.byteLength, start + 64 * 1024));
          const ack = await requestVscodeHost<{ bytes: number }>('file.save.write', { sinkId, offset, bytes: bytes.buffer });
          offset += bytes.byteLength;
          if (ack.bytes !== offset) throw new Error('The host did not write the complete download chunk');
        }
      },
      async close() { if (closed) return false; closed = true; return requestVscodeHost<boolean>('file.save.close', { sinkId }); },
      async abort() { if (closed) return; closed = true; await requestVscodeHost<void>('file.save.abort', { sinkId }); },
    };
  },
  async pickFiles() {
    const files = await requestVscodeHost<readonly SelectedFilePayload[] | null>('file.pick');
    return files?.map(toSelectedFile) ?? null;
  },
  pickDirectory: () => requestVscodeHost<string | null>('directory.pick'),
  pickDirectories: () => requestVscodeHost<readonly string[] | null>('directory.pickMany'),
  revealPath: (path) => requestVscodeHost<void>('path.reveal', { path }),
  openPath: (path) => requestVscodeHost<void>('file.open', { path }),
  writeFileText: (path, text) => requestVscodeHost<void>('file.writeText', { path, text }),
  openFile: (path, line, column) => requestVscodeHost<void>('file.open', { path, line, column }),
  showDiff: (originalPath, modifiedPath, title) =>
    requestVscodeHost<void>('diff.open', { originalPath, modifiedPath, title }),
  openTerminal: (cwd) => requestVscodeHost<void>('terminal.open', { cwd }),
  writeClipboard: (text) => requestVscodeHost<void>('clipboard.write', { text }),
  openExternal: (url) => requestVscodeHost<void>('external.open', { url }),
  openUrl: (url) => requestVscodeHost<void>('external.open', { url }),
};

function getApi(): VscodeApi {
  if (api !== undefined) return api;
  const acquire = (globalThis as unknown as { acquireVsCodeApi: AcquireVscodeApi }).acquireVsCodeApi;
  api = acquire();
  return api;
}

function installResponseListener(): void {
  if (listenerInstalled) return;
  listenerInstalled = true;
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const response = event.data as Partial<HostResponse>;
    if (response.channel !== 'kiki.vscode-host.response' || typeof response.id !== 'string') return;
    const request = pending.get(response.id);
    if (request === undefined) return;
    pending.delete(response.id);
    if (request.timer !== undefined) clearTimeout(request.timer);
    if (response.ok) {
      request.resolve(response.result);
    } else {
      request.reject(new Error(response.error ?? 'VS Code host request failed.'));
    }
  });
}

function toUint8Array(bytes: Uint8Array | ArrayBuffer | readonly number[]): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes);
}

function toSelectedFile(payload: SelectedFilePayload): HostSelectedFile {
  const data = toUint8Array(payload.bytes);
  return {
    name: payload.name,
    size: data.byteLength,
    type: payload.type,
    async read() {
      return new File([data as BlobPart], payload.name, {
        type: payload.type,
      });
    },
  };
}
