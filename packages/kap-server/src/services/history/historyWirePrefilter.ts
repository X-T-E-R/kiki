import type { ContextRecord } from '@kiki/transcript-live/wireRecords';

const OPAQUE_TYPES = ['llm.request', 'tools.update_store', 'profile.bind', 'usage.record', 'token_counting.measured', 'staleGuard.recorded'];
const OPAQUE_PREFIXES = OPAQUE_TYPES.map(type => ({ prefix: Buffer.from(`{"type":"${type}",`), record: { type } }));
const BOUNDARY_PATTERNS = ['turn.prompt', 'context.undo', 'context.clear', 'branch.base', 'turn_begin'].map(type => Buffer.from(`"${type}"`));

export function historyBoundaryCandidate(line: Buffer): boolean {
  return BOUNDARY_PATTERNS.some(pattern => line.indexOf(pattern) >= 0);
}

export function historyNavigationRecord(line: Buffer): ContextRecord | undefined {
  for (const { prefix, record } of OPAQUE_PREFIXES) {
    if (line.length >= prefix.length && line.subarray(0, prefix.length).equals(prefix)) return record;
  }
  return undefined;
}
