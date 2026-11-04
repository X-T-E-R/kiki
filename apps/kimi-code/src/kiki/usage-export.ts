import { readFile } from 'node:fs/promises';
import { createKlient } from '@kiki/klient/http';
import { usageExportSaveSchema, usageExportScopeSchema } from '@kiki/protocol';
import { z } from 'zod';
import type { Command } from 'commander';
import { ensureServer } from './serve';
import { resolveKikiHome } from './home';

async function inputJson(path: string): Promise<unknown> {
  const text = path === '-' ? await (async () => { let input = ''; for await (const chunk of process.stdin) { input += String(chunk); if (Buffer.byteLength(input) > 65536) throw new Error('Usage export input exceeds 64 KiB.'); } return input; })() : await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > 65536) throw new Error('Usage export input exceeds 64 KiB.'); return JSON.parse(text) as unknown;
}
export function registerUsageExportCommand(program: Command): void {
  const group = program.command('usage-export').description('Export content-free usage from this local Kiki home.').option('--home <dir>', 'Local source home.');
  const run = async (command: Command, action: (service: NonNullable<ReturnType<typeof createKlient>['rest']>['usageExport']) => Promise<unknown>) => {
    const connection = await ensureServer({ homeDir: resolveKikiHome(command.optsWithGlobals()['home'] as string | undefined) });
    const client = createKlient({ endpoint: connection.url, token: connection.token });
    try { process.stdout.write(JSON.stringify(await action(client.rest!.usageExport), null, 2) + '\n'); } finally { await client.close(); }
  };
  group.command('status').description('Show consent, source coverage, queue and delivery state.').action(async (_options, command: Command) => run(command, (s) => s.status()));
  group.command('save').requiredOption('--input <file>', 'JSON {draft,secret?,auto_upload?}; - reads stdin.').description('Save a draft, or explicitly enable/disable the supplied destination with auto_upload.').action(async (options: { input: string }, command: Command) => run(command, async (s) => s.saveDraft(usageExportSaveSchema.parse(await inputJson(options.input)))));
  group.command('connect-vibe')
    .requiredOption('--config <file>', 'Existing Vibe usage config containing apiUrl and apiKey; the key is never printed.')
    .requiredOption('--agree', 'Authorize content-free usage to this receiver every 2 hours; prefer keyring storage, otherwise a private file.')
    .option('--id <draft>', 'Update this saved destination, preserving its scope unless --start-at is supplied.')
    .option('--start-at <UTC>', 'Export from this absolute UTC half-hour boundary, e.g. 2026-01-01T00:00:00Z.')
    .description('Import the configured Vibe credential in memory and enable automatic upload; do not run an immediate sync.')
    .action(async (options: { config: string; agree: boolean; id?: string; startAt?: string }, command: Command) => {
      if (!options.agree) throw new Error('--agree is required.');
      let value: unknown;
      try { value = await inputJson(options.config); } catch { throw new Error('Could not read Vibe config JSON.'); }
      const config = z.object({ apiUrl: z.string().url(), apiKey: z.string().regex(/^vbu_[A-Za-z0-9._~+/-]{1,1000}$/) }).safeParse(value);
      if (!config.success) throw new Error('Vibe config requires a valid apiUrl and apiKey.');
      const origin = new URL(config.data.apiUrl);
      if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Vibe apiUrl must be an HTTPS origin without credentials, path, query or fragment.');
      const endpoint = new URL('/api/usage/ingest', origin).href;
      const start = options.startAt === undefined ? undefined : z.iso.datetime().safeParse(options.startAt);
      if (start !== undefined && (!start.success || Date.parse(start.data) % 1_800_000 !== 0)) throw new Error('--start-at must be an absolute UTC half-hour boundary.');
      if (options.id !== undefined && !z.uuid().safeParse(options.id).success) throw new Error('--id must be a destination UUID.');
      return run(command, async (s) => {
        const previous = options.id === undefined ? undefined : (await s.status()).destinations.find((entry) => entry.destination.id === options.id)?.destination;
        if (options.id !== undefined && previous === undefined) throw new Error('destination-not-found');
        if (previous !== undefined && previous.target.kind !== 'vibe') throw new Error('--id must name a Vibe destination.');
        const destination = await s.saveDraft({
          draft: {
            id: options.id, label: previous?.label ?? 'VibeCafe', target: { kind: 'vibe', endpoint }, schedule_minutes: 120,
            scope: { start_at: start?.success ? Date.parse(start.data) : previous?.scope.start_at ?? Math.floor(Date.now() / 1_800_000) * 1_800_000,
              end_at: previous?.scope.end_at ?? null, include_ephemeral: previous?.scope.include_ephemeral ?? false, excluded_workspace_ids: previous?.scope.excluded_workspace_ids ?? [] },
          },
          secret: { value: config.data.apiKey, storage: 'auto' }, auto_upload: true,
        });
        return { id: destination.id, label: destination.label, target: destination.target, scope: destination.scope, enabled: destination.enabled, state: destination.state, schedule_minutes: destination.schedule_minutes, credential_storage: destination.credential_storage };
      });
    });
  group.command('preview <id>').description('Read the authorized fields, exact range and consent fingerprint without uploading.').action(async (id: string, _options, command: Command) => run(command, (s) => s.preview(id)));
  group.command('test <id>').description('Explicitly test authentication and receiver protocol without sending usage.').action(async (id: string, _options, command: Command) => run(command, (s) => s.testProtocol(id)));
  group.command('enable <id>').requiredOption('--fingerprint <hash>', 'Fingerprint from the latest preview.').requiredOption('--agree', 'Approve this destination and range; scripts have full OS-user permissions.').description('Record consent once and enable background delivery.').action(async (id: string, options: { fingerprint: string; agree: boolean }, command: Command) => { if (!options.agree) throw new Error('--agree is required.'); return run(command, (s) => s.enable(id, { preview_fingerprint: options.fingerprint, acknowledge: true })); });
  group.command('disable <id>').description('Stop new requests immediately; preserve queued usage.').action(async (id: string, _options, command: Command) => run(command, (s) => s.disable(id)));
  group.command('sync <id>').description('Scan and deliver now using the same consent and durable queue.').action(async (id: string, _options, command: Command) => run(command, (s) => s.syncNow(id)));
  group.command('backfill <id>').requiredOption('--input <file>', 'Range JSON; - reads stdin.').description('Preview a changed range; expanding it requires enable with the new fingerprint.').action(async (id: string, options: { input: string }, command: Command) => run(command, async (s) => s.backfill(id, usageExportScopeSchema.parse(await inputJson(options.input)))));
  group.command('diagnostics').description('Print local, content-free coverage and delivery diagnostics.').action(async (_options, command: Command) => run(command, (s) => s.diagnostics()));
  group.command('export <id>').description('Print queued content-free payloads for a local backup.').action(async (id: string, _options, command: Command) => run(command, (s) => s.exportLocal(id)));
  group.command('rebuild').option('--force', 'Invalidate source checkpoints, including same-size/mtime rewrites; keep ACK history.').description('Reconcile the local projection; never modify wire facts.').action(async (options: { force?: boolean }, command: Command) => run(command, (s) => s.rebuild(options.force === true)));
  group.command('retry <id>').description('Retry paused or quarantined deliveries after fixing their cause.').action(async (id: string, _options, command: Command) => run(command, (s) => s.retry(id)));
  group.command('capacity <bytes>').description('Set the persistent queue limit (default 50 MiB); no oldest-item eviction.').action(async (bytes: string, _options, command: Command) => run(command, (s) => s.setQueueCapacity(Number(bytes))));
  group.command('clear-queue <id>').requiredOption('--agree', 'Discard this destination’s pending data and disable it.').description('Explicitly discard the queue; keep delivery identity and revision history.').action(async (id: string, options: { agree: boolean }, command: Command) => { if (!options.agree) throw new Error('--agree is required.'); return run(command, (s) => s.clearQueue(id, true)); });
  group.command('withdraw <id>').requiredOption('--agree', 'Send versioned deletion tombstones; keep local usage.').description('Withdraw exported buckets where the receiver supports deletion.').action(async (id: string, options: { agree: boolean }, command: Command) => { if (!options.agree) throw new Error('--agree is required.'); return run(command, (s) => s.withdraw(id, true)); });
  group.command('remove <id>').option('--discard-pending', 'Explicitly discard pending data; never delete remote history.').description('Remove the local destination and its secret, preserving delivery identity records.').action(async (id: string, options: { discardPending?: boolean }, command: Command) => run(command, (s) => s.remove(id, options.discardPending === true)));
  const handoff = group.command('handoff').description('Transfer this home from an existing vibe collector at a future UTC boundary.');
  handoff.command('status <id>').action(async (id: string, _options, command: Command) => run(command, (s) => s.handoff(id)));
  handoff.command('plan <id>').option('--cutoff <milliseconds>', 'Future UTC half-hour boundary; default is two boundaries ahead.').description('Prepare a new native destination; leave the collector running.').action(async (id: string, options: { cutoff?: string }, command: Command) => run(command, (s) => s.planHandoff(id, options.cutoff === undefined ? undefined : Number(options.cutoff))));
  handoff.command('arm <id>').requiredOption('--collector-file <file>', 'The collector’s prepared kiki-handoff.json, including its actual target identity.').requiredOption('--fingerprint <hash>', 'Fingerprint from native preview, after the plan and protocol test.').requiredOption('--agree', 'Activate this home’s old-collector cutoff and enable native delivery from the same boundary.').description('Verify donor identity, persist native consent and activate the cutoff; do not stop the daemon.').action(async (id: string, options: { collectorFile: string; fingerprint: string; agree: boolean }, command: Command) => { if (!options.agree) throw new Error('--agree is required.'); return run(command, (s) => s.armHandoff(id, { collector_file: options.collectorFile, preview_fingerprint: options.fingerprint, acknowledge: true })); });
  handoff.command('refresh <id>').description('Read the collector’s final safe receipt and native durable ACK state.').action(async (id: string, _options, command: Command) => run(command, (s) => s.refreshHandoff(id)));
  handoff.command('rollback <id>').requiredOption('--cutoff <milliseconds>', 'New future UTC half-hour boundary.').requiredOption('--agree', 'Keep native responsible before this boundary and resume the old collector afterward.').description('Set a new cutoff; never resume an unbounded legacy scan.').action(async (id: string, options: { cutoff: string; agree: boolean }, command: Command) => { if (!options.agree) throw new Error('--agree is required.'); return run(command, (s) => s.rollbackHandoff(id, Number(options.cutoff), true)); });
}
