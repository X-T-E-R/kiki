import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tauriHost } from './tauri';

const {
  checkDesktopUpdate: checkNativeDesktopUpdate,
  supportsDesktopUpdates,
  onFileDrop,
  onTrayNewSession,
  pickDirectories: selectDirectoriesNative,
  pickDirectory: selectDirectoryNative,
  pickFiles: selectFilesNative,
  openUrl: openExternalUrl,
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

  it('blocks native file and directory operations in SSH scope and restores local operations', async () => {
    tauriHost.connection.setWorkspaceScope('ssh');
    try {
      await expect(tauriHost.pickDirectory()).rejects.toThrow('SSH workspace');
      await expect(tauriHost.pickDirectories()).rejects.toThrow('SSH workspace');
      await expect(tauriHost.revealPath('/home/dev/project')).rejects.toThrow('SSH workspace');
      await expect(tauriHost.openPath('/home/dev/project')).rejects.toThrow('SSH workspace');
      await expect(tauriHost.writeFileText('/home/dev/file', 'data')).rejects.toThrow('SSH workspace');
      expect(invoke).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      tauriHost.connection.setWorkspaceScope('local');
    }
    invoke.mockResolvedValueOnce(undefined);
    await tauriHost.openPath('C:/work/example.txt');
    expect(invoke).toHaveBeenCalledWith('open_host_path', { path: 'C:/work/example.txt' });
  });

  it('passes SSH profile operations through narrow native commands', async () => {
    const profile = { id: 'host-1', label: 'Example', target: { kind: 'alias', alias: 'example' }, releaseChannel: 'stable' } as const;
    const token = 'a'.repeat(43);
    invoke.mockResolvedValueOnce([]).mockResolvedValueOnce([profile])
      .mockRejectedValueOnce('Host key not trusted').mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
    await expect(tauriHost.connection.listSshProfiles()).resolves.toEqual([]);
    await expect(tauriHost.connection.saveSshProfile(profile)).resolves.toEqual([profile]);
    await expect(tauriHost.connection.connectSshProfile('host-1', token)).rejects.toBe('Host key not trusted');
    await expect(tauriHost.connection.sshTunnelRunning('host-1', 'tunnel-one')).resolves.toBe(true);
    await tauriHost.connection.disconnectSshProfile('host-1', 'tunnel-one');
    expect(invoke.mock.calls).toEqual([
      ['list_ssh_profiles'],
      ['save_ssh_profile', { profile }],
      ['connect_ssh_profile', { id: 'host-1', token }],
      ['ssh_tunnel_running', { id: 'host-1', tunnelId: 'tunnel-one' }],
      ['disconnect_ssh_profile', { id: 'host-1', tunnelId: 'tunnel-one' }],
    ]);
  });

  it('opens a remote broker window with only the connection id in the existing command payload', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    await tauriHost.openRemoteSpace(connectionId);
    expect(invoke.mock.calls).toEqual([['open_space', { connectionId }]]);
    expect(Object.keys(invoke.mock.calls[0]![1])).toEqual(['connectionId']);
    invoke.mockRejectedValueOnce(new Error('window unavailable'));
    await expect(tauriHost.openRemoteSpace(connectionId)).rejects.toThrow('window unavailable');
  });

  it('routes external links through the native default-browser command', async () => {
    await openExternalUrl('https://example.test/docs');
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.test/docs' });
  });

  it('round-trips the app-scope update record through the native prefs commands', async () => {
    const updateState = {
      skipped: { stable: ['0.3.2', '0.3.3'], beta: ['0.3.2-beta.1'] },
      snoozedUntil: 1_791_200_000_123,
      lastCheckedAt: 1_791_113_600_123,
    };
    const nativePrefs = { notifications: false, autoUpdate: 'install', updateState };
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(nativePrefs);
    await expect(tauriHost.writeDesktopPrefs({ updateState })).resolves.toBeUndefined();
    expect(invoke).toHaveBeenNthCalledWith(1, 'write_desktop_prefs', { prefs: { updateState } });
    expect(JSON.parse(JSON.stringify(invoke.mock.calls[0]![1]))).toEqual({ prefs: { updateState } });
    await expect(tauriHost.readDesktopPrefs()).resolves.toEqual(nativePrefs);
    expect(invoke).toHaveBeenNthCalledWith(2, 'read_desktop_prefs');
  });

  it('distinguishes an omitted update record from explicit clearing across JSON serialization', async () => {
    await tauriHost.writeDesktopPrefs({ notifications: true });
    await tauriHost.writeDesktopPrefs({ updateState: undefined });
    await tauriHost.writeDesktopPrefs({ updateState: {} });
    await tauriHost.writeDesktopPrefs({ updateState: { lastCheckedAt: 123, snoozedUntil: undefined } });
    expect(invoke.mock.calls.map(([, args]) => JSON.parse(JSON.stringify(args)))).toEqual([
      { prefs: { notifications: true } },
      { prefs: { updateState: {} } },
      { prefs: { updateState: {} } },
      { prefs: { updateState: { lastCheckedAt: 123 } } },
    ]);
  });

  it('reports native prefs write failures instead of claiming a successful save', async () => {
    invoke.mockRejectedValueOnce(new Error('desktop.json is not writable'));
    await expect(tauriHost.writeDesktopPrefs({ updateState: { lastCheckedAt: 123 } }))
      .rejects.toThrow('desktop.json is not writable');
    expect(invoke).toHaveBeenCalledWith('write_desktop_prefs', { prefs: { updateState: { lastCheckedAt: 123 } } });
  });

  it('passes narrow update actions and returns the native merged record, preserving replacement prefs separately', async () => {
    const updated = { skipped: { stable: ['0.3.2'] }, snoozedUntil: 999, lastCheckedAt: 123 };
    invoke.mockResolvedValueOnce(updated).mockRejectedValueOnce(new Error('disk refused'));
    await expect(tauriHost.mutateDesktopUpdateState({ kind: 'checked', at: 123 })).resolves.toEqual(updated);
    expect(invoke).toHaveBeenNthCalledWith(1, 'mutate_desktop_update_state', { mutation: { kind: 'checked', at: 123 } });
    await expect(tauriHost.mutateDesktopUpdateState({ kind: 'skip', channel: 'beta', version: '0.4.0-beta.1' })).rejects.toThrow('disk refused');
  });

  it('rejects stale install handles without a separate premature shutdown invoke', async () => {
    invoke.mockResolvedValueOnce({ currentVersion: '0.3.1', version: '0.3.2' });
    const update = await checkNativeDesktopUpdate('stable');
    invoke.mockRejectedValueOnce(new Error('selection changed'));
    await expect(update!.install()).rejects.toThrow('selection changed');
    expect(invoke.mock.calls).toEqual([
      ['check_desktop_update', { channel: 'stable' }],
      ['install_desktop_update', { channel: 'stable', version: '0.3.2' }],
    ]);
  });

  it('reads old native prefs without inventing update state and retains the unavailable-host fallback', async () => {
    const oldPrefs = { notifications: true, autoUpdate: 'install' };
    invoke.mockResolvedValueOnce(oldPrefs).mockRejectedValueOnce(new Error('command unavailable'));
    await expect(tauriHost.readDesktopPrefs()).resolves.toEqual(oldPrefs);
    await expect(tauriHost.readDesktopPrefs()).resolves.toBeNull();
  });

  it('queries whether this distribution supports desktop updates', async () => {
    invoke.mockResolvedValueOnce(true);
    await expect(supportsDesktopUpdates()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('supports_desktop_updates');
  });

  it('checks and installs a desktop update through native commands', async () => {
    invoke.mockResolvedValueOnce({
      currentVersion: '0.1.0-beta.1',
      version: '0.1.0-beta.2',
      date: '2026-08-21T00:00:00Z',
      notes: 'Update notes',
    });

    const update = await checkNativeDesktopUpdate('beta');
    await update?.install();

    expect(invoke.mock.calls).toEqual([
      ['check_desktop_update', { channel: 'beta' }],
      ['install_desktop_update', { channel: 'beta', version: '0.1.0-beta.2' }],
    ]);
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

  it('returns ordinary clipboard paths without stat or content reads, including large files', async () => {
    invoke.mockResolvedValue(['C:/fixtures/large.bin', 'C:/fixtures/report.pdf']);
    await expect(tauriHost.readClipboardFiles()).resolves.toEqual({ paths: ['C:/fixtures/large.bin', 'C:/fixtures/report.pdf'], media: [] });
    expect(invoke).toHaveBeenCalledWith('read_clipboard_file_paths');
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('classifies copied supported media lazily and keeps unsupported image formats as paths', async () => {
    invoke.mockResolvedValue(['C:/fixtures/shot.png', 'C:/fixtures/clip.mp4', 'C:/fixtures/logo.svg', 'C:/fixtures/folder.png']);
    stat.mockResolvedValueOnce({ size: 4 }).mockResolvedValueOnce({ size: 5 }).mockResolvedValueOnce({ isDirectory: true });
    readFile.mockResolvedValue(new Uint8Array([1]));
    vi.stubGlobal('File', class { constructor(_bytes: unknown, public name: string, public options: unknown) {} });
    const copied = await tauriHost.readClipboardFiles();
    expect(copied?.paths).toEqual(['C:/fixtures/logo.svg', 'C:/fixtures/folder.png']);
    expect(copied?.media.map(({ name, type }) => [name, type])).toEqual([['shot.png', 'image/png'], ['clip.mp4', 'video/mp4']]);
    expect(readFile).not.toHaveBeenCalled();
    await copied?.media[1]?.read();
    expect(readFile).toHaveBeenCalledExactlyOnceWith('C:/fixtures/clip.mp4');
  });

  it('distinguishes no OS files from failed clipboard reads', async () => {
    invoke.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('clipboard busy'));
    await expect(tauriHost.readClipboardFiles()).resolves.toBeNull();
    await expect(tauriHost.readClipboardFiles()).rejects.toThrow('clipboard busy');
    expect(readFile).not.toHaveBeenCalled();
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
