import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { collectorHandoffIdentitySchema, legacyHandoffReceiptSchema, type UsageExportDestination, type UsageExportHandoff } from '@kiki/protocol';
import { writePrivateFile } from '../../services/auth/privateFiles';

const boundary = z.number().int().nonnegative().refine((n) => n % 1_800_000 === 0);
const homeSchema = z.object({
  home: z.string(), cutoff_at: boundary, namespace: z.string(), active: z.boolean(),
  resume_ranges: z.array(z.object({ start_at: boundary, end_at: boundary.nullable() }).strict()),
  collector_identity: collectorHandoffIdentitySchema, last_receipt: legacyHandoffReceiptSchema.nullable(),
}).strict();
const documentSchema = z.object({ schema_version: z.literal('vibe.kiki.handoff.v1'), homes: z.array(homeSchema).max(1000) }).strict();
export async function canonicalExportHome(home: string): Promise<string> { const path = await realpath(resolve(home)); return process.platform === 'win32' ? path.toLowerCase() : path; }
export async function readCollectorHandoff(file: string, sourceHome: string, destination: UsageExportDestination, state: UsageExportHandoff, secret: string) {
  if (destination.target.kind !== 'vibe') throw new Error('handoff-requires-vibe');
  const handle = await open(file, 'r'); const bytes = Buffer.alloc(65_537); let size = 0;
  try { size = (await handle.read(bytes, 0, bytes.length, 0)).bytesRead; } finally { await handle.close(); }
  if (size > 65_536) throw new Error('collector-proof-too-large');
  const document = documentSchema.parse(JSON.parse(bytes.subarray(0, size).toString('utf8')));
  const home = await canonicalExportHome(sourceHome); const matches = document.homes.filter((item) => item.home === home);
  if (matches.length !== 1) throw new Error('collector-identity-cutoff-unproven');
  const entry = matches[0]!;
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 16);
  const cutoff = state.previous_cutoff_at ?? state.cutoff_at;
  if (entry.cutoff_at !== cutoff || entry.namespace !== state.namespace || (state.phase !== 'rollback-prepared' && entry.resume_ranges.length > 0) || entry.collector_identity.keyFingerprint !== fingerprint || entry.collector_identity.ingest_endpoint !== destination.target.endpoint || new URL('/api/usage/ingest', entry.collector_identity.apiUrl).href !== destination.target.endpoint) throw new Error('collector-identity-cutoff-unproven');
  if (entry.last_receipt !== null && JSON.stringify(entry.last_receipt.collector_identity) !== JSON.stringify(entry.collector_identity)) throw new Error('collector-receipt-identity-unproven');
  return { document, entry };
}
export async function activateCollectorHandoff(file: string, proof: Awaited<ReturnType<typeof readCollectorHandoff>>, now: number): Promise<void> {
  if (proof.entry.active) return;
  if (now >= proof.entry.cutoff_at) throw new Error('handoff-missed-unarmed-cutoff');
  proof.entry.active = true; await writePrivateFile(file, JSON.stringify(proof.document, null, 2) + '\n');
}
export async function resumeCollectorHandoff(file: string, proof: Awaited<ReturnType<typeof readCollectorHandoff>>, cutoff: number): Promise<void> {
  if (proof.entry.resume_ranges.some((range) => range.start_at === cutoff && range.end_at === null)) return;
  if (cutoff <= proof.entry.cutoff_at || proof.entry.resume_ranges.some((range) => range.end_at === null)) throw new Error('handoff-rollback-boundary-unproven');
  proof.entry.resume_ranges.push({ start_at: cutoff, end_at: null }); await writePrivateFile(file, JSON.stringify(proof.document, null, 2) + '\n');
}
