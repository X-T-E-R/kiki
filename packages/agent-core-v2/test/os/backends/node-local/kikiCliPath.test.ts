import { execFile } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  applyKikiCliEnv,
  ensureKikiCliShim,
  type KikiShimWriter,
  kikiShimFiles,
  prependPathEntry,
  resolveKikiCliLaunch,
  toShellExecutablePath,
} from '#/os/backends/node-local/kikiCliPath';
import { describe, expect, it } from 'vitest';

const SEA_EXE = 'C:\\Kiki\\runtime\\releases\\abc\\kiki-server.exe';
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const NODE_ENTRY = 'C:\\Kiki\\apps\\kimi-code\\dist\\main.mjs';

interface WriterHarness {
  readonly writer: KikiShimWriter;
  readonly written: { readonly path: string; readonly data: string }[];
  readonly directories: string[];
}

function writerHarness(seed: Record<string, string> = {}): WriterHarness {
  const written: { path: string; data: string }[] = [];
  const directories: string[] = [];
  const existing = new Map(Object.entries(seed));
  return {
    written,
    directories,
    writer: {
      mkdir: async (path) => {
        directories.push(path);
      },
      readFile: async (path) => existing.get(path),
      writeFile: async (path, data) => {
        existing.set(path, data);
        written.push({ path, data });
      },
    },
  };
}

describe('resolveKikiCliLaunch', () => {
  it('names the SEA binary through process.execPath', async () => {
    const launch = await resolveKikiCliLaunch({
      isSea: () => true,
      execPath: SEA_EXE,
      argv: [SEA_EXE, 'web'],
      isFile: () => Promise.resolve(true),
    });
    expect(launch).toEqual({ kind: 'executable', executable: SEA_EXE });
  });

  it('names a built main.mjs CLI entry run through node', async () => {
    const launch = await resolveKikiCliLaunch({
      isSea: () => false,
      execPath: NODE_EXE,
      argv: [NODE_EXE, '/app/dist/main.mjs', 'web'],
      isFile: () => Promise.resolve(true),
    });
    expect(launch).toEqual({ kind: 'node', nodePath: NODE_EXE, entryPath: '/app/dist/main.mjs' });
  });

  it('skips a development entry that cannot be named reliably', async () => {
    for (const entry of ['/app/src/main.ts', '/app/dist/other.mjs', '']) {
      const launch = await resolveKikiCliLaunch({
        isSea: () => false,
        execPath: '/usr/bin/node',
        argv: ['/usr/bin/node', entry],
        isFile: () => Promise.resolve(true),
      });
      expect(launch).toBeUndefined();
    }
  });

  it('skips when argv has no entry', async () => {
    const launch = await resolveKikiCliLaunch({
      isSea: () => false,
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node'],
      isFile: () => Promise.resolve(true),
    });
    expect(launch).toBeUndefined();
  });

  it('skips a main.mjs entry that is not on disk', async () => {
    const launch = await resolveKikiCliLaunch({
      isSea: () => false,
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/app/dist/main.mjs'],
      isFile: () => Promise.resolve(false),
    });
    expect(launch).toBeUndefined();
  });
});

describe('toShellExecutablePath', () => {
  it('translates drive-letter paths into the MSYS dialect', () => {
    expect(toShellExecutablePath('C:\\Users\\u\\.kiki\\bin\\shim\\kiki.exe')).toBe(
      '/c/Users/u/.kiki/bin/shim/kiki.exe',
    );
    expect(toShellExecutablePath('D:')).toBe('/d/');
    expect(toShellExecutablePath('/already/posix')).toBe('/already/posix');
  });
});

describe('kikiShimFiles', () => {
  it('quotes shell metacharacters literally, including embedded single quotes', () => {
    const path = "/opt/中文 $HOME `id` \"quote\" \\slash/a'b";
    const files = kikiShimFiles({ kind: 'executable', executable: path }, 'linux');
    expect(files[0]?.content).toBe("#!/bin/sh\nexec '/opt/中文 $HOME `id` \"quote\" \\slash/a'\\''b' \"$@\"\n");
  });

  it.each(([
    ['portable', "中文 space $KIKI_SHIM_UNSET `echo expanded` 'quote'"],
    ['posix', "中文 space $KIKI_SHIM_UNSET `echo expanded` 'quote' \"double\" \\backslash"],
  ] as const).filter(([kind]) => kind !== 'posix' || process.platform !== 'win32'))('executes the %s path and forwards argument boundaries through a real sh', async (_kind, directory) => {
    const scratch = fileURLToPath(new URL('../../../../../../.tmp/', import.meta.url));
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'shim-'));
    try {
      const install = join(root, directory);
      await mkdir(install);
      const node = join(install, process.platform === 'win32' ? 'node.exe' : 'node');
      await link(process.execPath, node).catch(() => copyFile(process.execPath, node));
      const entry = join(_kind === 'posix' ? root : install, 'main.mjs');
      await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      const shellPath = process.platform === 'win32' ? toShellExecutablePath : (path: string) => path;
      const args = ['中文 with space', '$literal', '`literal`', '"double"', "single'quote", '\\', ''];
      const forwarderNode = process.platform === 'win32' ? node.replaceAll('\\', '/') : node;
      const forwarderEntry = process.platform === 'win32' ? entry.replaceAll('\\', '/') : entry;
      const launch = await ensureKikiCliShim({
        kikiHome: root,
        platform: 'linux',
        isSea: () => false,
        execPath: forwarderNode,
        argv: [forwarderNode, forwarderEntry],
      });
      expect(launch).toBeDefined();
      const shellOptions = { timeout: 5_000, cwd: root };
      const runner = join(root, 'runner.sh');
      await writeFile(runner, "#!/bin/sh\nexec ./bin/shim/kiki '中文 with space' '$literal' '`literal`' '\"double\"' \"single'quote\" '\\' ''\n");
      const result = await promisify(execFile)('sh', [shellPath(runner)], shellOptions);
      expect(JSON.parse(result.stdout)).toEqual(args);
      const executable = kikiShimFiles({ kind: 'executable', executable: forwarderNode }, 'linux')[0]!;
      const executableShim = join(root, 'executable-shim');
      await writeFile(executableShim, executable.content);
      const version = await promisify(execFile)('sh', [shellPath(executableShim), '--version'], shellOptions);
      expect(version.stdout.trim()).toBe(process.version);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });
  it('renders only the sh forwarder on POSIX', () => {
    const files = kikiShimFiles({ kind: 'executable', executable: '/opt/kiki/kiki-server' }, 'linux');
    expect(files).toEqual([
      {
        name: 'kiki',
        content: "#!/bin/sh\nexec '/opt/kiki/kiki-server' \"$@\"\n",
        mode: 0o755,
      },
    ]);
  });

  it('renders an sh and a cmd forwarder for a packaged Windows build', () => {
    const files = kikiShimFiles({ kind: 'executable', executable: SEA_EXE }, 'win32');
    expect(files).toEqual([
      {
        name: 'kiki',
        content: `#!/bin/sh\nexec '${toShellExecutablePath(SEA_EXE)}' "$@"\n`,
        mode: 0o755,
      },
      {
        name: 'kiki.cmd',
        content: `@echo off\r\n"${SEA_EXE}" %*\r\n`,
        mode: 0o755,
      },
    ]);
  });

  it('forwards node plus the CLI entry for a Node-hosted Windows build', () => {
    const files = kikiShimFiles({ kind: 'node', nodePath: NODE_EXE, entryPath: NODE_ENTRY }, 'win32');
    expect(files).toEqual([
      {
        name: 'kiki',
        content: `#!/bin/sh\nexec '${toShellExecutablePath(NODE_EXE)}' '${toShellExecutablePath(NODE_ENTRY)}' "$@"\n`,
        mode: 0o755,
      },
      {
        name: 'kiki.cmd',
        content: `@echo off\r\n"${NODE_EXE}" "${NODE_ENTRY}" %*\r\n`,
        mode: 0o755,
      },
    ]);
  });
});

describe('prependPathEntry', () => {
  it('puts the entry first and keeps the rest verbatim', () => {
    expect(prependPathEntry('/usr/bin:/bin', '/shim', ':')).toBe('/shim:/usr/bin:/bin');
  });

  it('replaces an existing occurrence instead of duplicating it', () => {
    expect(prependPathEntry('/shim:/usr/bin:/shim', '/shim', ':')).toBe('/shim:/usr/bin');
  });

  it('matches Windows entries case-insensitively with either separator', () => {
    expect(prependPathEntry('C:\\Windows;c:/Users/u/SHIM', 'C:\\Users\\u\\shim', ';', true)).toBe(
      'C:\\Users\\u\\shim;C:\\Windows',
    );
  });

  it('preserves empty components and handles an unset PATH', () => {
    expect(prependPathEntry('/usr/bin:', '/shim', ':')).toBe('/shim:/usr/bin:');
    expect(prependPathEntry('', '/shim', ':')).toBe('/shim:');
    expect(prependPathEntry(undefined, '/shim', ':')).toBe('/shim');
  });
});

describe('applyKikiCliEnv', () => {
  it('prepends the shim directory and sets KIKI_CLI on POSIX', () => {
    const env: Record<string, string | undefined> = { PATH: '/usr/bin:/bin' };
    applyKikiCliEnv(env, {
      platform: 'linux',
      shimDir: '/home/u/.kiki/bin/shim',
      cliPath: '/opt/kiki/kiki-server',
    });
    expect(env['PATH']).toBe('/home/u/.kiki/bin/shim:/usr/bin:/bin');
    expect(env['KIKI_CLI']).toBe('/opt/kiki/kiki-server');
  });

  it('uses the Windows separator when prefixed on win32', () => {
    const env: Record<string, string | undefined> = { PATH: 'C:\\Windows;C:\\Tools' };
    applyKikiCliEnv(env, {
      platform: 'win32',
      shimDir: 'C:\\Users\\u\\.kiki\\bin\\shim',
      cliPath: SEA_EXE,
    });
    expect(env['PATH']).toBe('C:\\Users\\u\\.kiki\\bin\\shim;C:\\Windows;C:\\Tools');
    expect(env['KIKI_CLI']).toBe(SEA_EXE);
  });
});

describe('ensureKikiCliShim', () => {
  it('skips a development run without writing anything', async () => {
    const harness = writerHarness();
    const shim = await ensureKikiCliShim({
      kikiHome: '/home/u/.kiki',
      platform: 'linux',
      isSea: () => false,
      execPath: '/usr/bin/node',
      argv: ['/usr/bin/node', '/app/src/main.ts'],
      isFile: () => Promise.resolve(true),
      writer: harness.writer,
    });
    expect(shim).toBeUndefined();
    expect(harness.directories).toEqual([]);
    expect(harness.written).toEqual([]);
  });

  it('writes the shim directory under KIKI_HOME and reports the launcher', async () => {
    const harness = writerHarness();
    const shimDir = join('/home/u/.kiki', 'bin', 'shim');
    const shim = await ensureKikiCliShim({
      kikiHome: '/home/u/.kiki',
      platform: 'linux',
      isSea: () => true,
      execPath: '/opt/kiki/kiki-server',
      argv: ['/opt/kiki/kiki-server', 'web'],
      writer: harness.writer,
    });
    expect(shim).toEqual({
      shimDir,
      cliPath: '/opt/kiki/kiki-server',
      writtenFiles: [join(shimDir, 'kiki')],
    });
    expect(harness.directories).toEqual([shimDir]);
  });

  it('rewrites only files whose content changed', async () => {
    const shimDir = join('/home/u/.kiki', 'bin', 'shim');
    const files = kikiShimFiles({ kind: 'executable', executable: '/opt/kiki/kiki-server' }, 'linux');
    const harness = writerHarness({
      [join(shimDir, files[0]!.name)]: files[0]!.content,
    });
    const written = await ensureKikiCliShim({
      kikiHome: '/home/u/.kiki',
      platform: 'linux',
      isSea: () => true,
      execPath: '/opt/kiki/kiki-server',
      argv: ['/opt/kiki/kiki-server', 'web'],
      writer: harness.writer,
    });
    expect(written?.writtenFiles).toEqual([]);
    expect(harness.written).toEqual([]);
  });
});
