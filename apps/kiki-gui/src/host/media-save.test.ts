import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriHost } from './tauri';

const fs = vi.hoisted(() => ({
  open: vi.fn(), mkdir: vi.fn(), rename: vi.fn(), copyFile: vi.fn(), remove: vi.fn(),
  write: vi.fn(), close: vi.fn(), save: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: fs.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ ...fs, BaseDirectory: { AppLocalData: 14 } }));

beforeEach(() => {
  for (const mock of Object.values(fs)) mock.mockReset();
  fs.save.mockResolvedValue('/user/selected.bin');
  fs.open.mockResolvedValue({ write: fs.write, close: fs.close });
  fs.mkdir.mockResolvedValue(undefined);
  fs.close.mockResolvedValue(undefined);
  fs.rename.mockResolvedValue(undefined);
  fs.copyFile.mockResolvedValue(undefined);
  fs.remove.mockResolvedValue(undefined);
});

describe('native original save sink', () => {
  it('awaits partial writes and commits only after closing the temporary file', async () => {
    fs.write.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
    const sink = (await tauriHost.openSaveSink!('original.bin'))!;
    expect(sink.streaming).toBe(true);
    await sink.write(new Uint8Array([1, 2, 3, 4]));
    expect(fs.write.mock.calls.map(([bytes]) => [...bytes])).toEqual([[1, 2, 3, 4], [3, 4]]);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await sink.close()).toBe(true);
    expect(fs.close.mock.invocationCallOrder[0]).toBeLessThan(fs.rename.mock.invocationCallOrder[0]!);
    expect(fs.open).toHaveBeenCalledWith(expect.stringMatching(/^kiki-media-saves\/.+\.part$/), { baseDir: 14, write: true, createNew: true });
    expect(fs.rename).toHaveBeenCalledWith(expect.stringMatching(/^kiki-media-saves\//), '/user/selected.bin', { oldPathBaseDir: 14 });
  });

  it('abort closes and removes only its own temporary file, never the selected existing target', async () => {
    const sink = (await tauriHost.openSaveSink!('original.bin'))!;
    await sink.abort();
    await sink.abort();
    expect(fs.close).toHaveBeenCalledTimes(1);
    expect(fs.remove).toHaveBeenCalledTimes(1);
    expect(fs.remove).toHaveBeenCalledWith(expect.stringMatching(/^kiki-media-saves\//), { baseDir: 14 });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
    await expect(sink.write(new Uint8Array([1]))).rejects.toThrow('closed');
  });

  it('cleans its temporary resource on close failure without touching the target', async () => {
    fs.close.mockRejectedValueOnce(new Error('close failed')).mockResolvedValueOnce(undefined);
    const sink = (await tauriHost.openSaveSink!('original.bin'))!;
    await expect(sink.close()).rejects.toThrow('close failed');
    expect(fs.remove).toHaveBeenCalledWith(expect.stringMatching(/^kiki-media-saves\//), { baseDir: 14 });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
  });

  it('reports cross-volume copy failure honestly and never removes the user-selected file', async () => {
    fs.rename.mockRejectedValue(new Error('EXDEV'));
    fs.copyFile.mockRejectedValue(new Error('disk full'));
    const sink = (await tauriHost.openSaveSink!('original.bin'))!;
    await expect(sink.close()).rejects.toThrow('selected file may be incomplete');
    await sink.abort();
    expect(fs.remove.mock.calls.every(([path]) => path !== '/user/selected.bin')).toBe(true);
  });

  it('does not fall back to destructive copy on a permission failure', async () => {
    fs.rename.mockRejectedValue(new Error('permission denied'));
    const sink = (await tauriHost.openSaveSink!('original.bin'))!;
    await expect(sink.close()).rejects.toThrow('permission denied');
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.remove).toHaveBeenCalledTimes(1);
  });
});
