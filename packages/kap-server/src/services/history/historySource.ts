import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

export type HistoryRefKind = 'turn' | 'step' | 'frame';

export interface HistorySourceAnchor {
  readonly v: 1;
  readonly workspace: string;
  readonly session: string;
  readonly agent: string;
  readonly kind: HistoryRefKind;
  readonly turn: number;
  readonly step?: string;
  readonly frame?: string;
  readonly incarnation: string;
  readonly start: number;
  readonly end: number;
  readonly digest: string;
  readonly selector?: string;
  readonly focus?: number;
}

export type HistorySourceResult = { readonly status: 'ok' } |
  { readonly status: 'stale_ref' | 'source_missing' };

const MAX_RECORD_BYTES = 64 << 20;
const AGENT_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export async function historySourceIncarnation(wirePath: string): Promise<string | undefined> {
  try {
    const info = await stat(wirePath, { bigint: true });
    return info.isFile() ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function encodeHistoryRef(anchor: HistorySourceAnchor): string {
  return `h1_${Buffer.from(JSON.stringify(anchor)).toString('base64url')}`;
}

export function decodeHistoryRef(value: string): HistorySourceAnchor {
  if (!value.startsWith('h1_') || value.length > 2048) throw new Error('invalid_ref');
  let anchor: unknown;
  try { anchor = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_ref'); }
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) throw new Error('invalid_ref');
  const a = anchor as Partial<HistorySourceAnchor>;
  if (a.v !== 1 || typeof a.workspace !== 'string' || !a.workspace ||
      typeof a.session !== 'string' || !a.session || typeof a.agent !== 'string' ||
      !AGENT_ID.test(a.agent) || a.agent === '.' || a.agent === '..' ||
      !['turn', 'step', 'frame'].includes(a.kind ?? '') ||
      !Number.isSafeInteger(a.turn) || (a.turn ?? -1) < 0 ||
      (a.step !== undefined && !/^t\d+\.\d+$/u.test(a.step)) ||
      (a.frame !== undefined && (typeof a.frame !== 'string' || a.frame.length > 256)) ||
      typeof a.incarnation !== 'string' || !a.incarnation ||
      !Number.isSafeInteger(a.start) || (a.start ?? -1) < 0 ||
      !Number.isSafeInteger(a.end) || (a.end ?? 0) <= (a.start ?? -1) ||
      (a.end ?? 0) - (a.start ?? 0) > MAX_RECORD_BYTES ||
      typeof a.digest !== 'string' || !SHA256.test(a.digest) ||
      (a.selector !== undefined && (typeof a.selector !== 'string' || a.selector.length > 128 ||
        !/^(?:input|event\.(?:part\.text|args|result\.output)|message\.content(?:\.\d+)?|message\.toolCalls\.\d+\.arguments)$/u.test(a.selector))) ||
      (a.focus !== undefined && (!Number.isSafeInteger(a.focus) || a.focus < 0))) throw new Error('invalid_ref');
  return a as HistorySourceAnchor;
}

export async function verifyHistorySource(wirePath: string, anchor: HistorySourceAnchor): Promise<HistorySourceResult> {
  const incarnation = await historySourceIncarnation(wirePath);
  if (incarnation === undefined) return { status: 'source_missing' };
  if (incarnation !== anchor.incarnation) return { status: 'stale_ref' };
  const file = await open(wirePath, 'r').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (file === undefined) return { status: 'source_missing' };
  try {
    const size = anchor.end - anchor.start;
    if (size <= 0 || size > MAX_RECORD_BYTES) return { status: 'stale_ref' };
    const hash = createHash('sha256');
    let read = 0;
    while (read < size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 << 10, size - read));
      const result = await file.read(chunk, 0, chunk.length, anchor.start + read);
      if (result.bytesRead === 0) return { status: 'stale_ref' };
      hash.update(chunk.subarray(0, result.bytesRead));
      read += result.bytesRead;
    }
    if (hash.digest('hex') !== anchor.digest) return { status: 'stale_ref' };
    return await historySourceIncarnation(wirePath) === anchor.incarnation
      ? { status: 'ok' } : { status: 'stale_ref' };
  } finally {
    await file.close();
  }
}

export function hashHistoryRecord(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
