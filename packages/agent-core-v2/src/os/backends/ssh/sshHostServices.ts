import type { SSHKaos } from '@kiki/kaos/ssh';
import { KaosFileNotFoundError, KaosPermissionError } from '@kiki/kaos/ssh';

import { decodeTextWithErrors } from '#/_base/execEnv/decodeText';
import { abortable } from '#/_base/utils/abort';
import { locateSshTail, readSshLineRange, type SshLineOptions } from './sshFileLines';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { HostProcessOptions, IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { spawnWindowsSearch } from '#/os/backends/ssh/windowsSearch';

type Connect = () => Promise<SSHKaos>;

function hostFsError(error: unknown): unknown {
  if (error instanceof KaosFileNotFoundError || error instanceof KaosPermissionError) {
    return Object.assign(new Error(error.message, { cause: error }), {
      code: error instanceof KaosFileNotFoundError ? 'ENOENT' : 'EACCES',
    });
  }
  return error;
}

async function withConnection<T>(connect: Connect, work: (ssh: SSHKaos) => Promise<T>): Promise<T> {
  try {
    return await work(await connect());
  } catch (error) {
    throw hostFsError(error);
  }
}

function fileStat(st: Awaited<ReturnType<SSHKaos['stat']>>): HostFileStat {
  const kind = st.stMode & 0o170000;
  return {
    isFile: kind === 0o100000,
    isDirectory: kind === 0o040000,
    isSymbolicLink: kind === 0o120000,
    size: st.stSize,
    mtimeMs: st.stMtime * 1000,
    ino: st.stIno,
    mode: st.stMode,
    uid: st.stUid,
  };
}

export class SshHostFileSystem implements IHostFileSystem {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly connect: Connect) {}

  readText(path: string, options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }): Promise<string> {
    return withConnection(this.connect, async (ssh) => decodeTextWithErrors(
      await ssh.readBytes(path), options?.encoding ?? 'utf-8', options?.errors ?? 'strict',
    ));
  }

  writeText(path: string, data: string): Promise<void> {
    return withConnection(this.connect, async (ssh) => { await ssh.writeText(path, data); });
  }

  appendText(path: string, data: string): Promise<void> {
    return withConnection(this.connect, async (ssh) => { await ssh.writeText(path, data, { mode: 'a' }); });
  }

  readBytes(path: string, n?: number, offset?: number): Promise<Uint8Array> {
    return withConnection(this.connect, (ssh) => ssh.readBytes(path, n, offset));
  }

  writeBytes(path: string, data: Uint8Array): Promise<void> {
    return withConnection(this.connect, async (ssh) => { await ssh.writeBytes(path, Buffer.from(data)); });
  }

  async *readLines(path: string, options: SshLineOptions = {}): AsyncGenerator<string> {
    yield* this.readLineRange(path, { ...options, startLine: 1, maxLines: Number.POSITIVE_INFINITY });
  }

  async *readLineRange(path: string, options: SshLineOptions & { startLine: number; maxLines: number }): AsyncGenerator<string> {
    options.signal?.throwIfAborted();
    if (options.maxLines <= 0) return;
    const connection = withConnection(this.connect, async (ssh) => ssh);
    const ssh = await (options.signal === undefined ? connection : abortable(connection, options.signal));
    try { yield* readSshLineRange(ssh, path, options); } catch (error) { throw hostFsError(error); }
  }

  async readTailRange(path: string, options: { tailLines: number; encoding?: 'utf-8' | 'utf8'; errors?: SshLineOptions['errors']; signal?: AbortSignal }): Promise<{ startLine: number; totalLines: number; lines: AsyncGenerator<string> }> {
    options.signal?.throwIfAborted();
    const connection = withConnection(this.connect, async (ssh) => ssh);
    const ssh = await (options.signal === undefined ? connection : abortable(connection, options.signal));
    const located = await withConnection(async () => ssh, (connection) => locateSshTail(connection, path, options));
    const lines = async function* (): AsyncGenerator<string> {
      try {
        const before = await ssh.stat(path);
        if (before.stSize !== located.size || before.stMtime !== located.mtime) throw new Error('SSH file changed before reading the requested line window. Retry the read.');
        if (located.size > 0) yield* readSshLineRange(ssh, path, { ...options, startByte: located.startByte, endByte: located.size - 1 });
        const after = await ssh.stat(path);
        if (after.stSize !== located.size || after.stMtime !== located.mtime) throw new Error('SSH file changed while reading the requested line window. Retry the read.');
      } catch (error) { throw hostFsError(error); }
    };
    return { startLine: located.startLine, totalLines: located.totalLines, lines: lines() };
  }

  createExclusive(path: string, data: Uint8Array): Promise<boolean> {
    return withConnection(this.connect, (ssh) => ssh.createExclusive(path, Buffer.from(data)));
  }

  stat(path: string): Promise<HostFileStat> {
    return withConnection(this.connect, async (ssh) => fileStat(await ssh.stat(path)));
  }

  lstat(path: string): Promise<HostFileStat> {
    return withConnection(this.connect, async (ssh) => fileStat(await ssh.stat(path, { followSymlinks: false })));
  }

  readdir(path: string): Promise<readonly { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }[]> {
    return withConnection(this.connect, async (ssh) => (await ssh.readdir(path)).map(({ name, mode }) => ({
      name,
      isFile: (mode & 0o170000) === 0o100000,
      isDirectory: (mode & 0o170000) === 0o040000,
      isSymbolicLink: (mode & 0o170000) === 0o120000,
    })));
  }

  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void> {
    return withConnection(this.connect, (ssh) => ssh.mkdir(path, { parents: options?.recursive, existOk: options?.recursive }));
  }

  remove(path: string): Promise<void> {
    return withConnection(this.connect, (ssh) => ssh.remove(path));
  }

  realpath(path: string): Promise<string> {
    return withConnection(this.connect, (ssh) => ssh.realpath(path));
  }
}

export class SshHostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(private readonly connect: Connect) {}

  spawn(command: string, args: readonly string[] = [], options: HostProcessOptions = {}): Promise<IHostProcess> {
    if (options.detached === true) throw new Error('Detached SSH processes are not supported');
    return withConnection(this.connect, async (ssh) => {
      if (!command) throw new Error('No executable shell was found on the remote SSH host');
      const scoped = ssh.withCwd(options.cwd ?? ssh.getcwd());
      if (command === 'rg' && ssh.osEnv.osKind === 'Windows') return spawnWindowsSearch(scoped, args);
      const process = ssh.osEnv.shellName === 'powershell' && command === ssh.osEnv.shellPath &&
        (args[0]?.toLowerCase() === '-command' || args[0]?.toLowerCase() === '-c') && args.length === 2
        ? await scoped.execPowerShell(args[1]!, options.env)
        : await scoped.execWithEnv([command, ...args], options.env);
      return {
        _serviceBrand: undefined,
        pid: process.pid,
        get exitCode() { return process.exitCode; },
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
        wait: () => process.wait(),
        kill: (signal) => process.kill(signal),
        dispose: () => process.dispose(),
      };
    });
  }
}
