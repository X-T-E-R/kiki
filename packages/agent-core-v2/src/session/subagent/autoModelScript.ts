import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import { Error2, ErrorCodes } from '#/errors';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import type { SubagentConfig } from './configSection';
import type { AutoModelInput } from './autoModel';

const PROCESS_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);
const OUTPUT_BYTES = 8192;

export function resolveAutoModelScript(config: SubagentConfig['autoModel'], cwd: string) {
  const script = config?.scripts?.find((entry) => entry.id === config.script &&
    entry.workspaces.some((workspace) => resolve(workspace) === resolve(cwd)));
  if (script === undefined || process.platform === 'win32' && !/\.exe$/i.test(script.command)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector script is not registered for this workspace with an absolute executable.');
  }
  return { kind: 'script' as const, id: script.id, command: script.command, args: [...script.args], timeout: script.timeout, cwd };
}

export async function runAutoModelScript(
  processes: IHostProcessService,
  script: ReturnType<typeof resolveAutoModelScript>,
  input: AutoModelInput,
  signal: AbortSignal,
): Promise<unknown> {
  const deadline = createDeadlineAbortSignal(signal, script.timeout * 1000);
  let proc: IHostProcess | undefined;
  try {
    deadline.signal.throwIfAborted();
    proc = await processes.spawn(script.command, script.args, {
      cwd: script.cwd, shell: false, ownedProcessTree: true,
      envUnset: ['KIKI_HOME', ...Object.keys(process.env).filter((key) => !PROCESS_ENV.has(key.toUpperCase()))],
    });
    deadline.signal.throwIfAborted();
    const stdout = readSelectorOutput(proc.stdout);
    const stderr = drain(proc.stderr);
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
    const [exitCode, output] = await abortable(Promise.all([proc.wait(), stdout, stderr]), deadline.signal);
    if (exitCode !== 0) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector script exited unsuccessfully.', { details: { exitCode } });
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector script returned invalid JSON.');
    }
  } catch (error) {
    if (deadline.timedOut()) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector script timed out.');
    signal.throwIfAborted();
    throw error;
  } finally {
    deadline.clear();
    if (proc !== undefined) {
      await proc.kill('SIGKILL');
      await proc.dispose();
    }
  }
}

async function readSelectorOutput(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    bytes += chunk.byteLength;
    if (bytes > OUTPUT_BYTES) throw new Error2(ErrorCodes.CONFIG_INVALID, 'Model selector output exceeded 8192 bytes.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function drain(stream: Readable): Promise<void> {
  for await (const _ of stream) continue;
}
