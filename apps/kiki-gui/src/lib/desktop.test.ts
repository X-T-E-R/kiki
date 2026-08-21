import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dryRunNativeSessionsMigration,
  executeNativeSessionsMigration,
  migrateNativeCompatibilityCategory,
  type SessionsMigrationPlan,
} from './desktop';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  isTauri: () => true,
}));

describe('native Sessions migration bridge', () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.unstubAllGlobals();
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
});
