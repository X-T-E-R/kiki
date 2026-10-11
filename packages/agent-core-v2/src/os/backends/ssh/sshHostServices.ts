import type { SSHKaos } from '@kiki/kaos/ssh';
import { KaosFileNotFoundError, KaosPermissionError } from '@kiki/kaos/ssh';

import { decodeTextWithErrors } from '#/_base/execEnv/decodeText';
import { splitLinesKeepingTerminator } from '#/_base/text/line-endings';
import type { HostFileStat, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { HostProcessOptions, IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

type Connect = () => Promise<SSHKaos>;

async function withConnection<T>(connect: Connect, work: (ssh: SSHKaos) => Promise<T>): Promise<T> {
  try {
    return await work(await connect());
  } catch (error) {
    if (error instanceof KaosFileNotFoundError || error instanceof KaosPermissionError) {
      throw Object.assign(new Error(error.message, { cause: error }), {
        code: error instanceof KaosFileNotFoundError ? 'ENOENT' : 'EACCES',
      });
    }
    throw error;
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

  async *readLines(path: string, options?: { encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }): AsyncGenerator<string> {
    yield* splitLinesKeepingTerminator(await this.readText(path, options));
  }

  async *readLineRange(path: string, options: { startLine: number; maxLines: number; encoding?: BufferEncoding; errors?: 'strict' | 'replace' | 'ignore' }): AsyncGenerator<string> {
    const lines = splitLinesKeepingTerminator(await this.readText(path, options));
    yield* lines.slice(Math.max(0, options.startLine - 1), Math.max(0, options.startLine - 1) + options.maxLines);
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
      if (!command) throw new Error('No shell was found on the remote SSH host. Install Git for Windows there to use Bash; SFTP file tools remain available.');
      const process = await ssh.withCwd(options.cwd ?? ssh.getcwd()).execWithEnv(
        [command, ...args], options.env,
      );
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
