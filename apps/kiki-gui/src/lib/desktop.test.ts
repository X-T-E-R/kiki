import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkNativeDesktopUpdate,
  dryRunNativeSessionsMigration,
  executeNativeSessionsMigration,
  importNativeKimiConfig,
  migrateNativeCompatibilityCategory,
  onTrayNewSession,
  selectDirectoriesNative,
  selectDirectoryNative,
  selectFilesNative,
  type SessionsMigrationPlan,
} from './desktop';

const { invoke, listen, open, readFile, stat, tauriRuntime } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  open: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  tauriRuntime: { value: true },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  isTauri: () => tauriRuntime.value,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile, stat }));

describe('native desktop bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
    open.mockReset();
    readFile.mockReset();
    stat.mockReset();
    tauriRuntime.value = true;
    vi.unstubAllGlobals();
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

  it('keeps dry-run and execution as separate native actions with structured facts', async () => {
    const plan: SessionsMigrationPlan = {
      status: 'ready',
      sourceRoot: 'C:/source-home',
      targetRoot: 'C:/kiki-home',
      sessionCount: 2,
      totalBytes: 1234,
      plannedMoves: [
        {
          entry: 'workspaces.json',
          source: 'C:/source-home/workspaces.json',
          target: 'C:/kiki-home/workspaces.json',
        },
        {
          entry: 'sessions',
          source: 'C:/source-home/sessions',
          target: 'C:/kiki-home/sessions',
        },
      ],
      targetConflict: false,
      blocker: null,
      execution: 'filesystemRename',
    };
    invoke.mockResolvedValueOnce(plan);

    await expect(dryRunNativeSessionsMigration()).resolves.toEqual(plan);
    expect(invoke).toHaveBeenCalledWith('dry_run_sessions_migration');
    expect(invoke).toHaveBeenCalledTimes(1);

    const moved = { ...plan, status: 'moved' as const };
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    invoke.mockResolvedValueOnce(moved);
    await expect(executeNativeSessionsMigration()).resolves.toEqual(moved);
    expect(invoke).toHaveBeenLastCalledWith('execute_sessions_migration');
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload while execution remains blocked', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    invoke.mockResolvedValueOnce({ status: 'blocked' });

    await expect(executeNativeSessionsMigration()).resolves.toMatchObject({ status: 'blocked' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads only after an imported config restarts successfully', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    invoke.mockResolvedValueOnce({
      status: 'imported',
      source: 'C:/source-home/config.toml',
      target: 'C:/kiki-home/config.toml',
      updatedCategories: ['providers', 'default_model'],
      restartError: null,
    });
    await expect(importNativeKimiConfig()).resolves.toMatchObject({ status: 'imported' });
    expect(invoke).toHaveBeenCalledWith('import_kimi_config');
    expect(reload).toHaveBeenCalledTimes(1);

    invoke.mockResolvedValueOnce({
      status: 'noop',
      source: 'C:/source-home/config.toml',
      target: 'C:/kiki-home/config.toml',
      updatedCategories: [],
      restartError: null,
    });
    await expect(importNativeKimiConfig()).resolves.toMatchObject({ status: 'noop' });

    invoke.mockResolvedValueOnce({
      status: 'imported',
      source: 'C:/source-home/config.toml',
      target: 'C:/kiki-home/config.toml',
      updatedCategories: ['models'],
      restartError: 'restart failed',
    });
    await expect(importNativeKimiConfig()).resolves.toMatchObject({ restartError: 'restart failed' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('surfaces a completed category copy whose activation setting is still pending', async () => {
    invoke.mockResolvedValueOnce({
      status: 'copiedActivationPending',
      category: 'userSkills',
      source: 'C:/source-home/skills',
      target: 'C:/kiki-home/skills',
      files: 3,
      activationError: 'desktop prefs are read-only',
    });

    await expect(migrateNativeCompatibilityCategory('userSkills')).resolves.toMatchObject({
      status: 'copiedActivationPending',
      files: 3,
      activationError: 'desktop prefs are read-only',
    });
    expect(invoke).toHaveBeenCalledWith('migrate_compatibility_category', {
      category: 'userSkills',
    });
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
