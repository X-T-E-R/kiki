import type {
  BrowserHostAdapter,
  HostNotification,
  HostSelectedFile,
  LocalConnection,
} from './host';

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
  readonly bytes: readonly number[];
}

type AcquireVscodeApi = () => VscodeApi;

let api: VscodeApi | undefined;
let listenerInstalled = false;
const pending = new Map<
  string,
  { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }
>();

export function isVscodeWebview(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
}

export function requestVscodeHost<T>(method: string, params: unknown = {}): Promise<T> {
  const vscode = getApi();
  installResponseListener();
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
    });
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    vscode.postMessage({ channel: 'kiki.vscode-host.request', id, method, params });
  });
}

export interface VscodeHostAdapter extends BrowserHostAdapter {
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
  notify: (options: HostNotification) => requestVscodeHost<void>('window.notify', options),
  isWindowVisibleAndFocused: () => requestVscodeHost<boolean>('window.focused'),
  async saveBlob(blob, filename) {
    const bytes = [...new Uint8Array(await blob.arrayBuffer())];
    return requestVscodeHost<boolean>('file.save', { filename, bytes });
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
    if (response.ok) {
      request.resolve(response.result);
    } else {
      request.reject(new Error(response.error ?? 'VS Code host request failed.'));
    }
  });
}

function toSelectedFile(payload: SelectedFilePayload): HostSelectedFile {
  return {
    name: payload.name,
    size: payload.bytes.length,
    type: payload.type,
    async read() {
      return new File([new Uint8Array(payload.bytes) as BlobPart], payload.name, {
        type: payload.type,
      });
    },
  };
}
