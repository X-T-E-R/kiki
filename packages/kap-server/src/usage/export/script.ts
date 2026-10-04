import { randomBytes } from 'node:crypto';

import { HostProcessService } from '@kiki/agent-core-v2/os/backends/node-local/hostProcessService';
import type { IHostProcess, IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';
import { usageExportBatchSchema, usageExportReceiptSchema, type UsageExportBatch } from '@kiki/protocol';
import { z } from 'zod';

import type { UsageExportAdapter, UsageExportAdapterContext, UsageExportErrorCategory } from './adapter';

export const SCRIPT_MAPPING_VERSION = 'kiki-script-bucket-v1';
export const usageExportScriptTestRequestSchema = z.object({ schema_version: z.literal('kiki.usage.test.v1'), nonce: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
export const usageExportScriptTestResponseSchema = z.object({ schema_version: z.literal('kiki.usage.test-receipt.v1'), nonce: z.string().regex(/^[a-f0-9]{32}$/), ready: z.literal(true) }).strict();

type CommandResult = { readonly outcome: 'ok'; readonly stdout: string } | { readonly outcome: 'retry' | 'invalid'; readonly errorCategory: UsageExportErrorCategory };

async function runScript(input: string, context: UsageExportAdapterContext, host: Pick<IHostProcessService, 'spawn'>): Promise<CommandResult> {
  if (context.target.kind !== 'script') return { outcome: 'invalid', errorCategory: 'script_protocol_error' };
  if (context.signal.aborted) return { outcome: 'retry', errorCategory: 'generic' };
  const target = context.target;
  let proc: IHostProcess;
  try { proc = await host.spawn(target.command, [], { shell: true }); }
  catch { return { outcome: 'retry', errorCategory: 'script_spawn_failed' }; }
  return new Promise<CommandResult>((resolve) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;
    let failure: CommandResult | undefined;
    let stopping: Promise<void> | undefined;
    const stop = (): void => {
      stopping ??= (async () => {
        if (proc.exitCode === null) { try { await proc.kill('SIGTERM'); } catch {} }
        await new Promise<void>((done) => { setTimeout(done, 100); });
        if (proc.exitCode === null) { try { await proc.kill('SIGKILL'); } catch {} }
      })();
    };
    const fail = (result: CommandResult): void => {
      if (finished) return;
      failure ??= result;
      stop();
      void stopping?.then(() => settle(result));
    };
    const onAbort = (): void => { fail({ outcome: 'retry', errorCategory: 'generic' }); };
    const timer = setTimeout(() => { fail({ outcome: 'retry', errorCategory: 'script_timeout' }); }, target.timeout_ms);
    context.signal.addEventListener('abort', onAbort, { once: true });
    const consume = (chunk: Buffer | string, stdout: boolean): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > target.output_limit_bytes) { fail({ outcome: 'retry', errorCategory: 'script_output_limit' }); return; }
      if (stdout && failure === undefined) chunks.push(bytes);
    };
    proc.stdout.on('data', (chunk: Buffer | string) => { consume(chunk, true); });
    proc.stderr.on('data', (chunk: Buffer | string) => { consume(chunk, false); });
    const stdoutDone = new Promise<void>((done) => { proc.stdout.once('end', done); });
    const stderrDone = new Promise<void>((done) => { proc.stderr.once('end', done); });
    const settle = async (result: CommandResult): Promise<void> => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      await stopping;
      await proc.dispose();
      // oxlint-disable-next-line promise/no-multiple-resolved -- finished guards the single resolve across exit, timeout and abort
      resolve(failure ?? result);
    };
    void Promise.all([proc.wait(), stdoutDone, stderrDone]).then(
      ([code]) => settle(code === 0 ? { outcome: 'ok', stdout: Buffer.concat(chunks).toString('utf8') } : { outcome: 'retry', errorCategory: 'script_nonzero_exit' }),
      () => settle({ outcome: 'retry', errorCategory: 'generic' }),
    );
    proc.stdin.on('error', () => { fail({ outcome: 'retry', errorCategory: 'script_protocol_error' }); });
    if (context.signal.aborted) onAbort();
    if (failure === undefined) proc.stdin.end(input);
  });
}

export function createScriptUsageAdapter(host: Pick<IHostProcessService, 'spawn'> = new HostProcessService()): UsageExportAdapter {
  return {
    kind: 'script', mappingVersion: SCRIPT_MAPPING_VERSION,
    capabilities: { absoluteReplace: true, delete: true, perItemAck: true }, maxBatchItems: 200, maxBodyBytes: 1_048_576,
    async test(context) {
      const nonce = randomBytes(16).toString('hex');
      const request = usageExportScriptTestRequestSchema.parse({ schema_version: 'kiki.usage.test.v1', nonce });
      const output = await runScript(JSON.stringify(request), context, host);
      if (output.outcome !== 'ok') return output;
      try {
        const receipt = usageExportScriptTestResponseSchema.parse(JSON.parse(output.stdout));
        if (receipt.nonce !== nonce) return { outcome: 'retry', errorCategory: 'script_protocol_error' };
        return { outcome: 'delivered' };
      } catch { return { outcome: 'retry', errorCategory: 'script_invalid_receipt' }; }
    },
    async send(batch, context) {
      let parsed: UsageExportBatch;
      try { parsed = usageExportBatchSchema.parse(batch); } catch { return { outcome: 'invalid', errorCategory: 'script_protocol_error' }; }
      const input = JSON.stringify(parsed);
      if (Buffer.byteLength(input) > 1_048_576) return { outcome: 'too-large', errorCategory: 'http_too_large' };
      const output = await runScript(input, context, host);
      if (output.outcome !== 'ok') return output;
      try {
        const receipt = usageExportReceiptSchema.parse(JSON.parse(output.stdout));
        if (receipt.batch_id !== parsed.batch_id) return { outcome: 'retry', errorCategory: 'script_protocol_error' };
        const expected = new Map(parsed.items.map(item => [`${item.stream_id}/${item.bucket_id}`, item]));
        const seen = new Set<string>();
        let diverged = false;
        let rejected = false;
        for (const ack of receipt.items) {
          const key = `${ack.stream_id}/${ack.bucket_id}`;
          const item = expected.get(key);
          if (!item || seen.has(key) || ack.revision !== item.revision || ack.payload_hash !== item.payload_hash) return { outcome: 'retry', errorCategory: 'script_protocol_error' };
          seen.add(key);
          diverged ||= ack.status === 'conflict' || ack.status === 'remote_diverged' || ack.status === 'stale';
          rejected ||= ack.status === 'rejected';
        }
        if (seen.size !== expected.size) return { outcome: 'retry', errorCategory: 'partial_receipt' };
        if (diverged) return { outcome: 'remote-diverged', receipt, errorCategory: 'remote_diverged' };
        if (rejected) return { outcome: 'invalid', receipt, errorCategory: 'script_protocol_error' };
        return { outcome: 'delivered', receipt };
      } catch { return { outcome: 'retry', errorCategory: 'script_invalid_receipt' }; }
    },
  };
}
