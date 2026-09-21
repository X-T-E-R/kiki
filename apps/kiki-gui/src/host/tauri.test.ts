import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriHost } from './tauri';

const {
  checkDesktopUpdate: checkNativeDesktopUpdate,
  onFileDrop,
  onTrayNewSession,
  pickDirectories: selectDirectoriesNative,
  pickDirectory: selectDirectoryNative,
  pickFiles: selectFilesNative,
} = tauriHost;

const { getCurrentWindow, invoke, listen, open, readFile, stat } = vi.hoisted(() => ({
  getCurrentWindow: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile, stat }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

describe('native desktop bridge', () => {
  beforeEach(() => {
    getCurrentWindow.mockReset();
    invoke.mockReset();
    listen.mockReset();
    open.mockReset();
    readFile.mockReset();
    stat.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([
    ['/C:/work/中 dir', 'C:/work/中 dir'],
    ['/D:\\work\\dir', 'D:\\work\\dir'],
    ['/var/a:b.ts', '/var/a:b.ts'],
    ['C:/work/a%20b.ts', 'C:/work/a%20b.ts'],
    ['C:/work/a b.ts', 'C:/work/a b.ts'],
    ['/work/a.ts:12', '/work/a.ts:12'],
    ['//server/share/file.ts', '//server/share/file.ts'],
  ])('passes real host path %s to both native openers', async (input, path) => {
    await tauriHost.revealPath(input);
    await tauriHost.openPath(input);
    expect(invoke).toHaveBeenNthCalledWith(1, 'reveal_host_path', { path });
    expect(invoke).toHaveBeenNthCalledWith(2, 'open_host_path', { path });
  });

  it('checks and installs a desktop update through native commands', async () => {
    invoke.mockResolvedValueOnce({
      currentVersion: '0.1.0-beta.1',
      version: '0.1.0-beta.2',
      date: '2026-08-21T00:00:00Z',
      notes: 'Update notes',
    });

    const update = await checkNativeDesktopUpdate();
    await update?.install();

    expect(invoke).toHaveBeenNthCalledWith(1, 'check_desktop_update');
    expect(invoke).toHaveBeenNthCalledWith(2, 'prepare_for_update');
    expect(invoke).toHaveBeenNthCalledWith(3, 'install_desktop_update');
  });

  it('routes directory picks through the native dialog with the directory flags', async () => {
    open.mockResolvedValueOnce(['C:/alpha', 'C:/beta']);
    await expect(selectDirectoriesNative()).resolves.toEqual(['C:/alpha', 'C:/beta']);
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: true });

    open.mockResolvedValueOnce('C:/single');
    await expect(selectDirectoryNative()).resolves.toBe('C:/single');
    expect(open).toHaveBeenLastCalledWith({ directory: true, multiple: false });

    open.mockResolvedValueOnce(null);
    await expect(selectDirectoriesNative()).resolves.toBeNull();
  });

  it('stats native file picks without reading their contents eagerly', async () => {
    open.mockResolvedValue(['C:/huge.bin', 'C:/small.txt']);
    stat
      .mockResolvedValueOnce({ size: 51 * 1024 * 1024 })
      .mockResolvedValueOnce({ size: 4 });
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const selected = await selectFilesNative();

    expect(stat).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalled();
    expect(selected?.map(({ name, size }) => ({ name, size }))).toEqual([
      { name: 'huge.bin', size: 51 * 1024 * 1024 },
      { name: 'small.txt', size: 4 },
    ]);

    await selected?.[1]?.read();
    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith('C:/small.txt');
  });

  it('delivers native file drops in CSS pixels and unregisters the listener', async () => {
    type DragDropProbeEvent =
      | { payload: { type: 'over'; position: { x: number; y: number } } }
      | {
          payload: {
            type: 'drop';
            paths: string[];
            position: { x: number; y: number };
          };
        };
    let emit!: (event: DragDropProbeEvent) => void;
    const unlisten = vi.fn();
    const onDragDropEvent = vi.fn((callback: (event: DragDropProbeEvent) => void) => {
      emit = callback;
      return Promise.resolve(unlisten);
    });
    const scaleFactor = vi.fn().mockResolvedValue(2);
    getCurrentWindow.mockReturnValue({ onDragDropEvent, scaleFactor });
    const receive = vi.fn();

    const stop = onFileDrop(receive);
    await Promise.resolve();
    emit({ payload: { type: 'over', position: { x: 200, y: 80 } } });
    expect(receive).not.toHaveBeenCalled();

    emit({
      payload: {
        type: 'drop',
        paths: ['C:\\work\\alpha.txt', 'D:\\my dir\\beta.txt'],
        position: { x: 200, y: 80 },
      },
    });
    await Promise.resolve();

    expect(scaleFactor).toHaveBeenCalledOnce();
    expect(receive).toHaveBeenCalledExactlyOnceWith({
      paths: ['C:\\work\\alpha.txt', 'D:\\my dir\\beta.txt'],
      position: { x: 100, y: 40 },
    });

    stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('unregisters a tray listener that resolves after its owner is disposed', async () => {
    let resolveListen!: (unlisten: () => void) => void;
    const unlisten = vi.fn();
    listen.mockReturnValue(
      new Promise<() => void>((resolve) => { resolveListen = resolve; }),
    );

    const stop = onTrayNewSession(() => {});
    stop();
    resolveListen(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
