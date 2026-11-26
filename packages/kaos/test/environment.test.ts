/**
 * Environment detection.
 *
 * Pins the cross-platform shape of `detectEnvironment()`:
 *
 *   - macOS / Linux / Windows / unknown → `osKind`
 *   - POSIX path probing prefers /bin/bash, falls back to /usr/bin/bash,
 *     /usr/local/bin/bash, then /bin/sh (with shellName 'sh').
 *   - Windows resolves Git Bash via `KIKI_SHELL_PATH`, `git.exe` on PATH
 *     (including `git --exec-path` for shims), well-known system install
 *     locations, or bundled Kiki `toolchain/`, falling back gracefully to
 *     PowerShell (`pwsh.exe` / `powershell.exe`) when no Bash is present.
 *   - `osArch` / `osVersion` are populated from the Node OS APIs.
 *
 * All tests expect `detectEnvironment()` to be a pure function of
 * injected platform probes (no ambient state) so the same suite runs
 * identically on macOS/Linux/Windows CI runners.
 */

import { describe, expect, it } from 'vitest';

import {
  applyBundledWindowsToolchainPath,
  detectEnvironment,
  type Environment,
  type OsKind,
  type ShellName,
} from '#/environment';

interface StubOpts {
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  readonly release?: string;
  readonly execPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly existingPaths?: readonly string[];
  readonly execFileResults?: Readonly<Record<string, string>>;
  readonly execFileText?: Parameters<typeof detectEnvironment>[0]['execFileText'];
}

/** Build a stub deps bag mimicking Node's `os` + `process` surface. */
function stubDeps(opts: StubOpts): Parameters<typeof detectEnvironment>[0] {
  const existing = new Set(opts.existingPaths ?? []);
  return {
    platform: opts.platform,
    arch: opts.arch ?? 'x86_64',
    release: opts.release ?? '1.2.3',
    execPath: opts.execPath,
    env: opts.env ?? {},
    isFile: async (path: string) => existing.has(path),
    execFileText:
      opts.execFileText ??
      (async (file: string, args: readonly string[]) => opts.execFileResults?.[execFileKey(file, args)]),
  };
}

function execFileKey(file: string, args: readonly string[]): string {
  return [file, ...args].join('\0');
}

describe('detectEnvironment', () => {
  it('reports osKind "macOS" on darwin', async () => {
    const env: Environment = await detectEnvironment(
      stubDeps({
        platform: 'darwin',
        arch: 'arm64',
        release: '23.4.0',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osKind satisfies OsKind).toBe('macOS');
    expect(env.osArch).toBe('arm64');
    expect(env.osVersion).toBe('23.4.0');
  });

  it('reports osKind "Linux" on linux', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'linux', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osKind).toBe('Linux');
  });

  it('reports osKind "Windows" on win32', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.osKind).toBe('Windows');
  });

  it('passes through unknown platform string verbatim', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'freebsd' as NodeJS.Platform, existingPaths: ['/bin/sh'] }),
    );
    // Python `Environment.detect` returns `platform.system()` verbatim
    // for unknown OS strings; TS mirrors that behaviour.
    expect(env.osKind).toBe('freebsd');
  });

  // ── POSIX shell probing ────────────────────────────────────────────

  it('prefers /bin/bash when it exists (shellName=bash)', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('/bin/bash');
  });

  it('falls back to /usr/bin/bash when /bin/bash is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/bin/bash', '/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/bin/bash');
  });

  it('falls back to /usr/local/bin/bash when /bin and /usr/bin are missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        existingPaths: ['/usr/local/bin/bash'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('/usr/local/bin/bash');
  });

  it('falls back to /bin/sh with shellName=sh when no bash is found', async () => {
    const env = await detectEnvironment(stubDeps({ platform: 'linux', existingPaths: [] }));
    expect(env.shellName).toBe('sh');
    expect(env.shellPath).toBe('/bin/sh');
  });

  // ── Windows Git Bash probing ───────────────────────────────────────

  it('uses KIKI_SHELL_PATH override when set and the file exists', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { KIKI_SHELL_PATH: 'D:\\custom\\bash.exe' },
        existingPaths: ['D:\\custom\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName satisfies ShellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\custom\\bash.exe');
  });

  it('infers Git Bash from git.exe on PATH when override is absent', async () => {
    const gitExe = 'C:\\Program Files\\Git\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Program Files\\Git\\cmd' },
        existingPaths: [gitExe, 'C:\\Program Files\\Git\\bin\\bash.exe'],
        execFileText: async (file: string) => {
          throw new Error(`unexpected execFileText call for ${file}`);
        },
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('resolves a Scoop git shim through git --exec-path', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('resolves a Scoop git shim through usr/bin when bin/bash.exe is missing', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\Users\\me\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 ucrt64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\ucrt64\\bin\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\ucrt64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/ucrt64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clang64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clang64\\bin\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clang64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clang64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('resolves MSYS2 clangarm64 native git through git --exec-path', async () => {
    const gitExe = 'C:\\msys64\\clangarm64\\bin\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\msys64\\clangarm64\\bin' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]: 'C:/msys64/clangarm64/libexec/git-core\n',
        },
        existingPaths: [gitExe, 'C:\\msys64\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\msys64\\usr\\bin\\bash.exe');
  });

  it('does not treat shim-adjacent bash.exe as the Git installation shell', async () => {
    const gitExe = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims' },
        execFileResults: {
          [execFileKey(gitExe, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [
          gitExe,
          'C:\\Users\\me\\scoop\\bin\\bash.exe',
          'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('checks later git.exe matches when the first one cannot resolve Git Bash', async () => {
    const scoopGit = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const portableGit = 'D:\\PortableGit\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims;D:\\PortableGit\\cmd' },
        existingPaths: [scoopGit, portableGit, 'D:\\PortableGit\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\PortableGit\\bin\\bash.exe');
  });

  it('keeps PATH order when an earlier shim resolves through git --exec-path', async () => {
    const scoopGit = 'C:\\Users\\me\\scoop\\shims\\git.exe';
    const portableGit = 'D:\\PortableGit\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Users\\me\\scoop\\shims;D:\\PortableGit\\cmd' },
        execFileResults: {
          [execFileKey(scoopGit, ['--exec-path'])]:
            'C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core\n',
        },
        existingPaths: [
          scoopGit,
          portableGit,
          'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe',
          'D:\\PortableGit\\bin\\bash.exe',
        ],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe');
  });

  it('skips relative Windows PATH entries before git --exec-path probing', async () => {
    const relativeGit = 'tools\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'tools' },
        existingPaths: [relativeGit],
        execFileText: async (file: string) => {
          throw new Error(`unexpected execFileText call for ${file}`);
        },
      }),
    );
    expect(env.shellName).toBe('powershell');
  });

  it('scans PATH directly for git.exe candidates', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'D:\\PortableGit\\cmd' },
        existingPaths: ['D:\\PortableGit\\cmd\\git.exe', 'D:\\PortableGit\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\PortableGit\\bin\\bash.exe');
  });

  it('infers Git Bash from usr/bin when bin/bash.exe is missing', async () => {
    const gitExe = 'D:\\Program Files\\Git\\cmd\\git.exe';
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'D:\\Program Files\\Git\\cmd' },
        existingPaths: [gitExe, 'D:\\Program Files\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellName).toBe('bash');
    expect(env.shellPath).toBe('D:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('falls back to the well-known Program Files install location', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to usr/bin under Program Files when bin/bash.exe is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        existingPaths: ['C:\\Program Files\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  });

  it('falls back to LOCALAPPDATA install when present', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: ['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('falls back to usr/bin under LOCALAPPDATA when bin/bash.exe is missing', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        existingPaths: ['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe'],
      }),
    );
    expect(env.shellPath).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe');
  });

  it('resolves bundled Kiki toolchain Git Bash after user system Git and before PowerShell fallback', async () => {
    const bundledBash = 'C:\\Users\\me\\AppData\\Local\\Kiki\\toolchain\\git\\bin\\bash.exe';
    const systemBash = 'C:\\Program Files\\Git\\bin\\bash.exe';

    const withSystemGit = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        execPath: 'C:\\Users\\me\\AppData\\Local\\Kiki\\kiki-server.exe',
        existingPaths: [bundledBash, systemBash],
      }),
    );
    expect(withSystemGit.shellName).toBe('bash');
    expect(withSystemGit.shellPath).toBe(systemBash);

    const virginWithBundle = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        execPath: 'C:\\Users\\me\\AppData\\Local\\Kiki\\kiki-server.exe',
        existingPaths: [bundledBash],
      }),
    );
    expect(virginWithBundle.shellName).toBe('bash');
    expect(virginWithBundle.shellPath).toBe(bundledBash);
  });

  it('falls back gracefully to PowerShell when neither system Git Bash nor bundled toolchain is present', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', SystemRoot: 'C:\\Windows' },
        existingPaths: [],
      }),
    );
    expect(env.shellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('prefers pwsh.exe on PATH when falling back without Git Bash on Windows', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'win32',
        env: { PATH: 'C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32' },
        existingPaths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      }),
    );
    expect(env.shellName).toBe('powershell');
    expect(env.shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  it('appends bundled toolchain directories at the tail of PATH without shadowing user entries', async () => {
    const envObj: Record<string, string | undefined> = {
      Path: 'C:\\Windows\\System32;C:\\CustomUserTools',
    };
    const root = 'C:\\Users\\me\\AppData\\Local\\Kiki\\toolchain';
    const resolvedRoot = await applyBundledWindowsToolchainPath({
      platform: 'win32',
      execPath: 'C:\\Users\\me\\AppData\\Local\\Kiki\\cli\\kiki.exe',
      env: envObj,
      isFile: async (p) =>
        p === `${root}\\git\\bin\\bash.exe` ||
        p === `${root}\\git\\cmd\\git.exe` ||
        p === `${root}\\git\\mingw64\\bin\\curl.exe` ||
        p === `${root}\\git\\usr\\bin\\bash.exe` ||
        p === `${root}\\bin\\rg.exe`,
    });
    expect(resolvedRoot).toBe(root);
    expect(envObj['Path']).toBe(
      [
        'C:\\Windows\\System32',
        'C:\\CustomUserTools',
        `${root}\\git\\cmd`,
        `${root}\\git\\mingw64\\bin`,
        `${root}\\git\\usr\\bin`,
        `${root}\\bin`,
      ].join(';'),
    );
  });

  // ── arch / version passthrough ─────────────────────────────────────

  it('reports osArch verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({ platform: 'darwin', arch: 'arm64', existingPaths: ['/bin/bash'] }),
    );
    expect(env.osArch).toBe('arm64');
  });

  it('reports osVersion verbatim from the injected probe', async () => {
    const env = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        release: '6.1.0-test',
        existingPaths: ['/bin/bash'],
      }),
    );
    expect(env.osVersion).toBe('6.1.0-test');
  });

  it('recognizes Android and iOS via KIKI_PLATFORM or platform, populates pathClass and homeDir, and honors POSIX KIKI_SHELL_PATH and /system/bin/sh', async () => {
    const androidEnv = await detectEnvironment({
      ...stubDeps({
        platform: 'linux',
        env: { KIKI_PLATFORM: 'android', KIKI_SHELL_PATH: '/data/local/bin/bash' },
        existingPaths: ['/data/local/bin/bash', '/system/bin/sh'],
      }),
      homeDir: '/data/user/0/kiki',
    });
    expect(androidEnv.osKind).toBe('Android');
    expect(androidEnv.pathClass).toBe('posix');
    expect(androidEnv.homeDir).toBe('/data/user/0/kiki');
    expect(androidEnv.shellName).toBe('bash');
    expect(androidEnv.shellPath).toBe('/data/local/bin/bash');

    const androidFallback = await detectEnvironment(
      stubDeps({
        platform: 'android' as NodeJS.Platform,
        existingPaths: ['/system/bin/sh'],
      }),
    );
    expect(androidFallback.osKind).toBe('Android');
    expect(androidFallback.shellName).toBe('sh');
    expect(androidFallback.shellPath).toBe('/system/bin/sh');

    const iosEnv = await detectEnvironment(
      stubDeps({
        platform: 'linux',
        env: { KIKI_PLATFORM: 'ios' },
        existingPaths: ['/bin/sh'],
      }),
    );
    expect(iosEnv.osKind).toBe('iOS');
  });
});
