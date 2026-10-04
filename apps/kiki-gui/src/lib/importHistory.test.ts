import { describe, expect, it } from 'vitest';

import type { ImportJob, ImportPreview } from '@kiki/protocol';
import { translatePlural } from '@kiki/session-core/i18n';

import {
  ACTIVE_JOB_STATES,
  archiveStateKey,
  homeName,
  importProgress,
  isJobActive,
  jobStateKey,
  lossCount,
  probeStateKey,
  recordRoleKey,
  importCountsText,
  shortDigest,
  shortPath,
  shortSourceId,
  UNFINISHED_JOB_STATES,
} from './importHistory';

const job = (patch: Partial<ImportJob>): ImportJob => ({
  schemaVersion: 1,
  id: 'job-1',
  previewId: 'preview-1',
  selection: { pluginId: 'p', sourceId: 'claude-code', home: 'C:/Users/ada/.claude', externalId: 'file-1' },
  sourceHome: 'C:/Users/ada/.claude',
  targetHome: 'main',
  revision: 'abc',
  title: 'A title',
  formatVersion: 'v1',
  status: 'running',
  createdAt: 0,
  updatedAt: 0,
  records: 0,
  pages: 0,
  bytesRead: 0,
  totalBytes: 1000,
  cursor: null,
  parsed: false,
  losses: [],
  archiveId: null,
  error: null,
  ...patch,
});

describe('importProgress', () => {
  it('reports a real ratio when the host measured the source', () => {
    const progress = importProgress(job({ bytesRead: 250, totalBytes: 1000 }));
    expect(progress?.ratio).toBe(0.25);
    expect(progress?.value).toBe(250);
  });

  it('reports no ratio when totalBytes is 0, so the bar can stay indeterminate', () => {
    // A source the host has not measured must not be drawn as 0% or 100%.
    const progress = importProgress(job({ bytesRead: 4096, totalBytes: 0 }));
    expect(progress?.ratio).toBeUndefined();
    expect(progress?.value).toBe(4096);
  });

  it('clamps a byte count past the measured total', () => {
    expect(importProgress(job({ bytesRead: 5000, totalBytes: 1000 }))?.value).toBe(1000);
  });

  it('has nothing to say about no job', () => {
    expect(importProgress(undefined)).toBeUndefined();
  });
});

describe('job states', () => {
  it('treats queued and running as live, and the rest as settled', () => {
    expect(ACTIVE_JOB_STATES.has('queued')).toBe(true);
    expect(ACTIVE_JOB_STATES.has('running')).toBe(true);
    for (const status of ['cancelled', 'failed', 'interrupted', 'completed'] as const) {
      expect(ACTIVE_JOB_STATES.has(status)).toBe(false);
    }
  });

  it('treats a stop, a failure and an interruption as resumable, and completion as final', () => {
    // A cancelled job and an interrupted one are both "resume", because the
    // host re-runs a read-only parse; a completed one is done.
    for (const status of ['cancelled', 'failed', 'interrupted'] as const) {
      expect(UNFINISHED_JOB_STATES.has(status)).toBe(true);
    }
    expect(UNFINISHED_JOB_STATES.has('completed')).toBe(false);
  });

  it('maps every schema state to a key rather than guessing one', () => {
    for (const status of ['queued', 'running', 'cancelled', 'failed', 'interrupted', 'completed'] as const) {
      expect(jobStateKey(status)).toBe(`cap.import.state.${status}`);
    }
  });

  it('reads a job as active only when the host says so', () => {
    expect(isJobActive(job({ status: 'running' }))).toBe(true);
    expect(isJobActive(job({ status: 'completed' }))).toBe(false);
    expect(isJobActive(undefined)).toBe(false);
  });
});

describe('vocabulary', () => {
  it('keeps a source home readable and a path short without losing its leaf', () => {
    expect(homeName('C:/Users/ada/.claude')).toBe('.claude');
    expect(homeName('C:\\Users\\ada\\.codex')).toBe('.codex');
    expect(shortPath('/home/ada/.claude/projects/a/session.jsonl')).toBe('a/session.jsonl');
    expect(shortPath('a/b')).toBe('a/b');
  });

  it('shortens a digest instead of letting 64 hex characters push its sentence away', () => {
    // Twelve characters is the cap the view draws; the full value stays in the
    // archive reader's own fact list.
    expect(shortDigest('bb12')).toBe('bb12');
    expect(shortDigest('bb12cc33dd44ee55')).toBe('bb12cc33dd44');
    expect(shortDigest('bb12cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899aabb')).toBe('bb12cc33dd44');
    expect(shortDigest(null)).toBe('—');
    expect(shortDigest('')).toBe('—');
  });

  it('sums the server’s own loss counts and never invents one', () => {
    expect(lossCount([
      { code: 'a', count: 4, detail: '' },
      { code: 'b', count: 7, detail: '' },
      { code: 'c', count: 0, detail: '' },
    ])).toBe(11);
    expect(lossCount([])).toBe(0);
  });

  it('keys every role the schema allows, and both archive statuses', () => {
    for (const role of ['user', 'assistant', 'system', 'tool', 'tool_call', 'metadata'] as const) {
      expect(recordRoleKey(role)).toMatch(/^[a-z]/);
    }
    expect(probeStateKey('preserved')).toBe('cap.import.probe.preserved');
    expect(probeStateKey('partial')).toBe('cap.import.probe.partial');
    expect(probeStateKey('unsupported')).toBe('cap.import.probe.unsupported');
    // An archive is preserved or partial — it is never "unsupported", because
    // an unsupported source cannot produce an archive at all.
    expect(archiveStateKey('preserved')).toBe('cap.import.probe.preserved');
    expect(archiveStateKey('partial')).toBe('cap.import.probe.partial');
  });
});

describe('coverage vocabulary', () => {
  it('names a bounded read a sample and a full read complete', () => {
    const base = {
      schemaVersion: 1 as const, id: 'p', selection: { pluginId: 'p', sourceId: 's', home: 'h', externalId: 'e' },
      targetHome: 'main',
      probe: { revision: 'r', title: 't', formatVersion: 'v', status: 'partial' as const, losses: [], totalBytes: 0, sourceHome: 'h' },
      records: [], losses: [], existingArchiveId: null, existingRevision: null, createdAt: 0,
    };
    const sample: ImportPreview = { ...base, coverage: 'sample' };
    const complete: ImportPreview = { ...base, coverage: 'complete' };
    // The two are different facts, and the view draws a tag for each.
    expect(sample.coverage).not.toBe(complete.coverage);
  });
});

/**
 * A source id is drawn on every conversation row, so what it looks like there
 * is a reading decision, and what is *sent* is not: the full id is what
 * selection, preview and submit carry, and it stays in the row's `title`.
 */
describe('shortSourceId', () => {
  it('shortens an id-shaped value and leaves a path as a path', () => {
    const uuid = '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3';
    // A uuid has no separator, so `shortPath` used to hand back all 36 chars —
    // a line of hex on every row, competing with the title beside it.
    expect(shortSourceId(uuid)).toBe('0f4d2a1c-6b8e');
    expect(shortSourceId(uuid)).not.toBe(uuid);
    expect(shortSourceId(uuid).length).toBeLessThan(uuid.length);
    // A real path keeps its path shape: a folder cut to twelve characters
    // would not name a folder.
    expect(shortSourceId('C:/Users/ada/.claude/projects/abc/session.jsonl')).toBe('abc/session.jsonl');
  });

  it('leaves a short value whole rather than inventing an ellipsis', () => {
    expect(shortSourceId('a1b2c3')).toBe('a1b2c3');
    expect(shortSourceId('2024-05-06-run')).toBe('2024-05-06-run');
  });

  it('keeps two different conversations distinguishable', () => {
    // The point of showing an id beside a title is that two rows can share a
    // title; shortening must not collapse them into one.
    const left = '0f4d2a1c-6b8e-4c3a-9d21-5e7f80a1b2c3';
    const right = '9b21ee40-4c3a-4c3a-9d21-5e7f80a1b2c3';
    expect(shortSourceId(left)).not.toBe(shortSourceId(right));
  });
});

describe('importCountsText', () => {
  const en = (base: Parameters<typeof translatePlural>[1], count: number) => translatePlural('en', base, count);
  const zh = (base: Parameters<typeof translatePlural>[1], count: number) => translatePlural('zh', base, count);

  it('agrees with itself on each number rather than on the pair', () => {
    // One page beside many records is the case that read as `1 pages`.
    expect(importCountsText(en, 3, 1)).toBe('3 records · 1 page');
    expect(importCountsText(en, 1, 1)).toBe('1 record · 1 page');
    expect(importCountsText(en, 12, 4)).toBe('12 records · 4 pages');
    // Zero is plural, and the numbers themselves are not negotiable.
    expect(importCountsText(en, 0, 0)).toBe('0 records · 0 pages');
  });

  it('leaves the Chinese counting fact unchanged', () => {
    // Chinese counters do not inflect, so both forms read as before.
    expect(importCountsText(zh, 3, 1)).toBe('3 条记录 · 1 页');
    expect(importCountsText(zh, 1, 1)).toBe('1 条记录 · 1 页');
  });
});
