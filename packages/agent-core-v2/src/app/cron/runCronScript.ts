import { type Readable } from 'node:stream';
import type { CronScriptExecution, CronTriggerCheck } from '@kiki/protocol';

import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

export const CRON_SCRIPT_OUTPUT_BYTES = 8192;
const PROCESS_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE']);

export interface CronScriptResult {
  readonly outcome: CronTriggerCheck['outcome'];
  readonly reason?: CronTriggerCheck['reason'];
  readonly exitCode?: number;
  readonly stdout?: string;
}

export async function runCronScript(
  processes: IHostProcessService,
  script: CronScriptExecution,
  input: { readonly jobId: string; readonly cron: string; readonly coalescedCount: number },
  signal: AbortSignal,
): Promise<CronScriptResult> {
  const deadline = createDeadlineAbortSignal(signal, script.timeout * 1000);
  let proc: IHostProcess | undefined;
  let result: CronScriptResult;
  try {
    deadline.signal.throwIfAborted();
    proc = await processes.spawn(script.command, script.args, {
      cwd: script.cwd, shell: false, ownedProcessTree: true,
      envUnset: ['KIKI_HOME', ...Object.keys(process.env).filter((key) => !PROCESS_ENV.has(key.toUpperCase()))],
    });
    const stdout = readBounded(proc.stdout, CRON_SCRIPT_OUTPUT_BYTES);
    const stderr = readBounded(proc.stderr, 0);
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
    const [exitCode, output] = await abortable(Promise.all([proc.wait(), stdout, stderr]), deadline.signal);
    result = exitCode === 0 ? { outcome: 'allowed', exitCode, stdout: output }
      : exitCode > 0 ? { outcome: 'skipped', reason: 'exit_code', exitCode }
        : { outcome: 'error', reason: 'process_failed' };
  } catch {
    result = { outcome: 'error', reason: deadline.timedOut() ? 'timeout' : signal.aborted ? 'cancelled' : 'process_failed' };
  } finally {
    deadline.clear();
  }
  if (proc !== undefined) {
    try {
      await proc.kill('SIGKILL');
      await proc.dispose();
    } catch {
      result = { outcome: 'error', reason: 'cleanup_failed' };
    }
  }
  return result;
}

async function readBounded(stream: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    const take = Math.min(chunk.byteLength, limit - bytes);
    if (take > 0) {
      chunks.push(chunk.subarray(0, take));
      bytes += take;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks), { stream: true });
}
