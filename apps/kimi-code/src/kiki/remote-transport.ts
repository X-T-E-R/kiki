import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REMOTE_POSIX_PATH =
  'export PATH=~/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ';

export type RemoteCommandRunner = (
  program: string,
  args: string[],
  archive?: string,
  outputArchive?: string,
) => Promise<string>;

export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isRemoteTarget(value: string | undefined): value is string {
  return value !== undefined && (value.startsWith('ccp:') || value.startsWith('ssh://'));
}

export async function remoteCommand(
  program: string,
  args: string[],
  archive?: string,
  outputArchive?: string,
): Promise<string> {
  const bashCcp = process.platform === 'win32' && program === 'ccp';
  const child = spawn(bashCcp ? 'bash.exe' : program, bashCcp ? ['-lc', 'exec ccp "$@"', 'ccp', ...args] : args, {
    stdio: [archive ? 'pipe' : 'ignore', 'pipe', 'inherit'],
    windowsHide: true,
    timeout: 180_000,
  });
  const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`${program} exited with ${code ?? signal}`));
    });
  });
  const readStdout =
    outputArchive !== undefined
      ? (async () => {
          let size = 0;
          const limit = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              size += chunk.length;
              if (size > 128 * 1024 * 1024) {
                child.kill();
                done(new Error('Remote archive output exceeds 128 MiB'));
              } else {
                done(null, chunk);
              }
            },
          });
          await pipeline(child.stdout!, limit, createWriteStream(outputArchive, { flags: 'wx', mode: 0o600 }));
          return '';
        })()
      : new Promise<string>((resolveStdout, rejectStdout) => {
          const stdout: Buffer[] = [];
          let length = 0;
          child.stdout!.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > 1024 * 1024) {
              child.kill();
              rejectStdout(new Error('Remote command output exceeds 1 MiB'));
            } else {
              stdout.push(chunk);
            }
          });
          child.stdout!.once('error', rejectStdout);
          child.stdout!.once('end', () => {
            resolveStdout(Buffer.concat(stdout).toString('utf8'));
          });
        });
  const [, stdout] = await Promise.all([
    exitPromise,
    readStdout,
    archive ? pipeline(createReadStream(archive), child.stdin!) : undefined,
  ]);
  return stdout;
}

export async function resolveRemoteTarget(
  remote: string,
  run: RemoteCommandRunner,
): Promise<{
  readonly invoke: (script: string, archive?: string, outputArchive?: string) => Promise<string>;
  readonly ready: string;
}> {
  if (remote.startsWith('ccp:')) {
    const runtime = remote.slice(4);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runtime)) throw new Error('Invalid CCP runtime ID');
    const result = JSON.parse(await run('ccp', ['ssh', 'prepare', runtime])) as { id?: string };
    const id = result.id;
    if (!id || !/^ssh_[A-Za-z0-9]+$/.test(id)) throw new Error('CCP did not return an SSH session ID');
    return {
      invoke: (script, archive, outputArchive) => run('ccp', ['ssh', 'connect', id, '--command', script], archive, outputArchive),
      ready: `ccp ssh connect ${id}`,
    };
  }
  const target = new URL(remote);
  if (
    target.protocol !== 'ssh:' ||
    target.password ||
    target.search ||
    target.hash ||
    !['', '/'].includes(target.pathname) ||
    !/^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])$/.test(target.hostname) ||
    !/^[\w.-]*$/.test(target.username) ||
    target.username.startsWith('-')
  ) {
    throw new Error('Remote target expects ssh://[user@]host[:port] or ccp:<runtimeId>');
  }
  const host = `${target.username ? `${target.username}@` : ''}${target.hostname}`;
  const args = [...(target.port ? ['-p', target.port] : []), '--', host];
  return {
    invoke: (script, archive, outputArchive) => run('ssh', ['-T', ...args, script], archive, outputArchive),
    ready: `ssh -t ${args.join(' ')}`,
  };
}
