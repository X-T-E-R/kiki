import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { NbSearchCredentialFileStore } from '#/app/nbSearch/credentialFileStore';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';

let disposables: DisposableStore;
const spawn = vi.fn();
const readBytes = vi.fn();
let store: NbSearchCredentialFileStore;
const handles: IHostProcess[] = [];

function handle(blocked: boolean): IHostProcess {
  const stdout = new PassThrough();
  if (!blocked) stdout.end('ok');
  const result: IHostProcess = {
    _serviceBrand: undefined, pid: 123, exitCode: null,
    stdin: new PassThrough(), stdout, stderr: new PassThrough(),
    wait: vi.fn(() => blocked ? new Promise<number>(() => {}) : Promise.resolve(0)),
    kill: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(() => { stdout.destroy(); }),
  };
  handles.push(result);
  return result;
}

beforeEach(() => {
  disposables = new DisposableStore();
  spawn.mockReset();
  readBytes.mockReset().mockResolvedValue(new TextEncoder().encode('{}'));
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(IHostFileSystem, {
        lstat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 2, ino: 1, mtimeMs: 1, mode: 0o600, uid: 1 }),
        readBytes,
      });
      reg.definePartialInstance(IHostProcessService, { spawn });
    },
  });
  store = new NbSearchCredentialFileStore(ix.get(IHostFileSystem), ix.get(IHostProcessService));
});

afterEach(() => {
  for (const processHandle of handles.splice(0)) processHandle.stdout.destroy();
  vi.useRealTimers();
  disposables.dispose();
});

describe.runIf(process.platform === 'win32')('NB-04 ACL execution budgets', () => {
  it.each(['stdout', 'wait'])('settles and kills its own ACL handle when %s hangs at the 15-second deadline', async (phase) => {
    vi.useFakeTimers();
    const processHandle = handle(true);
    if (phase === 'wait') (processHandle.stdout as PassThrough).end('ok');
    spawn.mockResolvedValue(processHandle);
    let settled = false;
    const outcome = store.read('C:/fixture/nb-search/secrets.json', true).then(
      () => { settled = true; return 'success'; },
      (error: { issue: string }) => { settled = true; return error.issue; },
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(settled).toBe(true);
    expect(await outcome).toBe('LOCAL_CREDENTIALS_TIMEOUT');
    expect(processHandle.kill).toHaveBeenCalledWith('SIGKILL');
    expect(processHandle.dispose).toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('also terminates an owned handle returned after the spawn deadline', async () => {
    vi.useFakeTimers();
    let resolveSpawn!: (value: IHostProcess) => void;
    const late = new Promise<IHostProcess>((resolve) => { resolveSpawn = resolve; });
    spawn.mockReturnValue(late);
    const outcome = store.read('C:/fixture/nb-search/secrets.json', true).catch((error: { issue: string }) => error.issue);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await outcome).toBe('LOCAL_CREDENTIALS_TIMEOUT');
    const processHandle = handle(true);
    resolveSpawn(processHandle);
    await vi.advanceTimersByTimeAsync(0);
    expect(processHandle.kill).toHaveBeenCalledWith('SIGKILL');
    expect(processHandle.dispose).toHaveBeenCalled();
  });

  it('batches directory and file ACL checks while rechecking permissions on both reads', async () => {
    spawn.mockImplementation(async () => handle(false));
    await store.read('C:/fixture/nb-search/secrets.json', true);
    await store.read('C:/fixture/nb-search/secrets.json', true);
    expect(spawn).toHaveBeenCalledTimes(2);
    await store.read('C:/fixture/nb-search/secrets.json', true);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(readBytes).toHaveBeenCalledTimes(3);
  });
});
