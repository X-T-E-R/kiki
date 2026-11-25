import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ELECTRON_RUN_AS_NODE_ENV,
  filterGuiChildEnv,
  maybeRedirectToCurrentRelease,
  NO_RELEASE_REDIRECT_ENV,
  resolveLaunchExecutable,
  resolveRedirectPlan,
} from '#/main/releaseRedirect';

const OLD_RELEASE = 'aaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb';
const NEW_RELEASE = 'cccccccccccccccccccccccc-dddddddddddddddddddddddd';

const tempDirs: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiki-desktop-redirect-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('releaseRedirect', () => {
  it('redirects v1 versioned release to aligned active/ binary before single-instance lock, forwarding argv and deep links', () => {
    const root = makeTempRoot();
    const oldDir = join(root, 'releases', OLD_RELEASE);
    const activeDir = join(root, 'active');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });

    const oldExe = join(oldDir, 'kiki-desktop.exe');
    writeFileSync(oldExe, 'old-desktop');
    writeFileSync(join(oldDir, 'kiki-server.exe'), 'old-server');

    const activeExe = join(activeDir, 'kiki-desktop.exe');
    writeFileSync(activeExe, 'new-desktop');
    writeFileSync(join(activeDir, 'kiki-server.exe'), 'new-server');
    writeFileSync(
      join(activeDir, 'active-release.json'),
      JSON.stringify({ schemaVersion: 1, releaseId: NEW_RELEASE }),
    );
    writeFileSync(
      join(root, 'current.json'),
      JSON.stringify({ schemaVersion: 1, releaseId: NEW_RELEASE }),
    );

    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      [ELECTRON_RUN_AS_NODE_ENV]: '1',
    };
    const spawned: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined; cwd: string | undefined }> = [];
    const exitCodes: number[] = [];

    const redirected = maybeRedirectToCurrentRelease({
      currentExe: oldExe,
      currentDir: oldDir,
      argv: [oldExe, '--home', 'C:/spaces/work', 'kiki://subscribe?url=https%3A%2F%2Fexample.com%2Ffeed'],
      env,
      deps: {
        platform: 'win32',
        spawnProcess: (command, args, options) => {
          spawned.push({ command, args, env: options.env, cwd: options.cwd as string | undefined });
          return { unref: () => undefined };
        },
        exitProcess: (code) => {
          exitCodes.push(code);
        },
      },
    });

    expect(redirected).toBe(true);
    expect(exitCodes).toEqual([0]);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe(activeExe);
    expect(spawned[0]?.args).toEqual([
      '--home',
      'C:/spaces/work',
      'kiki://subscribe?url=https%3A%2F%2Fexample.com%2Ffeed',
    ]);
    expect(spawned[0]?.cwd).toBe(activeDir);
    expect(spawned[0]?.env?.[NO_RELEASE_REDIRECT_ENV]).toBe('1');
    expect(spawned[0]?.env?.[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined();
  });

  it('supports schemaVersion 2 electron-single-binary manifests without kiki-server.exe', () => {
    const root = makeTempRoot();
    const oldDir = join(root, 'releases', OLD_RELEASE);
    const newDir = join(root, 'releases', NEW_RELEASE);
    const serverEntryRel = 'resources/app.asar.unpacked/dist/server/server-entry.mjs';

    mkdirSync(oldDir, { recursive: true });
    mkdirSync(join(newDir, 'resources/app.asar.unpacked/dist/server'), { recursive: true });

    const oldExe = join(oldDir, 'kiki-desktop.exe');
    const newExe = join(newDir, 'kiki-desktop.exe');
    writeFileSync(oldExe, 'old-desktop');
    writeFileSync(newExe, 'new-electron-single-binary');
    writeFileSync(join(newDir, serverEntryRel), 'export default {};');
    writeFileSync(
      join(root, 'current.json'),
      JSON.stringify({
        schemaVersion: 2,
        runtimeKind: 'electron-single-binary',
        releaseId: NEW_RELEASE,
        serverEntry: serverEntryRel,
      }),
    );

    const plan = resolveRedirectPlan({
      currentExe: oldExe,
      currentDir: oldDir,
      argv: [oldExe, '--tray-only'],
      env: { [ELECTRON_RUN_AS_NODE_ENV]: '1' },
      deps: { platform: 'win32' },
    });

    expect(plan).not.toBeNull();
    expect(plan?.executable).toBe(newExe);
    expect(plan?.release.schemaVersion).toBe(2);
    expect(plan?.release.isActive).toBe(false);
    expect(plan?.args).toEqual(['--tray-only']);
    expect(plan?.env[ELECTRON_RUN_AS_NODE_ENV]).toBeUndefined();
    expect(resolveLaunchExecutable(oldExe, { platform: 'win32' })).toBe(newExe);
  });

  it('consumes and clears inherited KIKI_NO_RELEASE_REDIRECT guard without looping', () => {
    const root = makeTempRoot();
    const oldDir = join(root, 'releases', OLD_RELEASE);
    const newDir = join(root, 'releases', NEW_RELEASE);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });

    const oldExe = join(oldDir, 'kiki-desktop.exe');
    writeFileSync(oldExe, 'old');
    writeFileSync(join(newDir, 'kiki-desktop.exe'), 'new');
    writeFileSync(join(newDir, 'kiki-server.exe'), 'new-server');
    writeFileSync(
      join(root, 'current.json'),
      JSON.stringify({ schemaVersion: 1, releaseId: NEW_RELEASE }),
    );

    const env: NodeJS.ProcessEnv = {
      [NO_RELEASE_REDIRECT_ENV]: '1',
      KEEP_ME: 'yes',
    };
    const redirected = maybeRedirectToCurrentRelease({
      currentExe: oldExe,
      argv: [oldExe],
      env,
      deps: { platform: 'win32' },
    });

    expect(redirected).toBe(false);
    expect(env[NO_RELEASE_REDIRECT_ENV]).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');

    // --no-release-redirect CLI flag skips redirect, whereas KIKI_NO_RELEASE_REDIRECT=0 still redirects.
    const skippedByFlag = resolveRedirectPlan({
      currentExe: oldExe,
      argv: [oldExe, '--no-release-redirect'],
      env: {},
      deps: { platform: 'win32' },
    });
    expect(skippedByFlag).toBeNull();

    const allowedWhenZero = resolveRedirectPlan({
      currentExe: oldExe,
      argv: [oldExe],
      env: { [NO_RELEASE_REDIRECT_ENV]: '0' },
      deps: { platform: 'win32' },
    });
    expect(allowedWhenZero).not.toBeNull();
  });

  it('strips both ELECTRON_RUN_AS_NODE and KIKI_NO_RELEASE_REDIRECT for GUI siblings', () => {
    const filtered = filterGuiChildEnv(
      {
        PATH: '/bin',
        ELECTRON_RUN_AS_NODE: '1',
        KIKI_NO_RELEASE_REDIRECT: '1',
        KIKI_HOME: '/tmp/home',
      },
      'linux',
    );
    expect(filtered).toEqual({ PATH: '/bin', KIKI_HOME: '/tmp/home' });
  });
});
