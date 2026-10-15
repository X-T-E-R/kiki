import { describe, expect, it } from 'vitest';
import { castDraft } from 'immer';
import { contextMemoryKey, applyContextCompactionRecord } from '#/agent/contextMemory/contextOps';
import { ContextUndo } from '#/agent/contextMemory/contextEvents';
import { expandedStateFolds, type FoldContext } from '#/state/state';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { coveredInstructions, instructionKey, instructionVersion, type InstructionFile } from '#/agent/agentsMdReminder/instructionCoverage';

const file: InstructionFile = { path: '/repo/AGENTS.md', scope: '/repo', runtimeId: 'local', version: instructionVersion('current rule') };
const key = (entry = file) => `${instructionKey(entry, 'posix')}:${entry.version}`;
const snapshot = (revision: number, files?: readonly InstructionFile[], previousRevision?: number): ContextMessage => ({ role: 'user', content: [], toolCalls: [],
  origin: { kind: 'injection', variant: 'runtime_snapshot', disclosure: { revision, previousRevision, instructions: files === undefined ? undefined : { mode: 'replace', files } } } });
const read = (startLine: number, endLine: number, patch = {}): ContextMessage => ({ role: 'tool', toolCalls: [], content: [], toolCallId: 'read',
  fileRead: { file, startLine, endLine, totalLines: 3, truncated: false, ...patch } });

describe('effective full instruction coverage', () => {
  it('folds a surviving full snapshot chain, including unchanged and explicit removal', () => {
    expect(coveredInstructions([snapshot(1, [file]), snapshot(2, undefined, 1)], 'posix').has(key())).toBe(true);
    expect(coveredInstructions([snapshot(1, [file]), snapshot(2, [], 1)], 'posix').has(key())).toBe(false);
    expect(coveredInstructions([snapshot(2, undefined, 1)], 'posix').has(key())).toBe(false);
  });
  it('does not grant coverage from arbitrary From text or incomplete/errored/truncated reads', () => {
    const arbitrary: ContextMessage = { role: 'user', toolCalls: [], content: [{ type: 'text', text: '<!-- From: /repo/AGENTS.md -->\ncurrent rule' }] };
    for (const history of [[arbitrary], [read(1, 2)], [read(1, 3, { truncated: true })], [{ ...read(1, 3), isError: true }]]) expect(coveredInstructions(history, 'posix').size).toBe(0);
  });
  it('accepts complete page unions of the same version and rejects mixed versions', () => {
    expect(coveredInstructions([read(1, 1), read(2, 3)], 'posix').has(key())).toBe(true);
    const newer = { ...file, version: instructionVersion('changed rule') };
    expect(coveredInstructions([read(1, 1), read(2, 3, { file: newer })], 'posix').size).toBe(0);
    expect(coveredInstructions([read(1, 3), snapshot(1, [newer])], 'posix').has(key(newer))).toBe(true);
    expect(coveredInstructions([read(1, 3)], 'posix').has(key(newer))).toBe(false);
  });
  it('uses the latest complete version across independent carriers without refreshing unchanged snapshot sections', () => {
    const newer = { ...file, version: instructionVersion('changed rule') };
    const full: ContextMessage = { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'agents_md', disclosure: { mode: 'add', files: [newer] } } };
    for (const history of [[snapshot(1, [file]), full], [snapshot(1, [file]), full, snapshot(2, undefined, 1)], [read(1, 3), full], [full, snapshot(1, [file]), snapshot(2, [newer], 1)]]) {
      const coverage = coveredInstructions(history, 'posix');
      expect(coverage.has(key(newer))).toBe(true);
      expect(coverage.has(key())).toBe(false);
    }
  });
  it('keeps independent complete disclosure/Read carriers when a snapshot removes its own carrier', () => {
    const full: ContextMessage = { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'agents_md', disclosure: { mode: 'add', files: [file] } } };
    expect(coveredInstructions([full, snapshot(1, [])], 'posix').has(key())).toBe(true);
    expect(coveredInstructions([read(1, 3), snapshot(1, [])], 'posix').has(key())).toBe(true);
    expect(coveredInstructions([], 'posix').size).toBe(0);
  });
  it('recomputes coverage from actual undo and compaction folds rather than remembered disclosure', () => {
    const prompt: ContextMessage = { role: 'user', content: [{ type: 'text', text: 'work' }], toolCalls: [], origin: { kind: 'user' } };
    const newer = { ...file, version: instructionVersion('changed rule') };
    const full: ContextMessage = { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'agents_md', disclosure: { mode: 'add', files: [newer] } } };
    const history = [prompt, snapshot(1, [file]), prompt, full];
    expect(coveredInstructions(history, 'posix').has(key(newer))).toBe(true);
    const foldContext: FoldContext = { silent: false, checkpoint: () => {}, clearCheckpoints: () => {}, undoToCheckpoint: () => {}, emit: () => {} };
    const undone = expandedStateFolds(contextMemoryKey).get(ContextUndo)!(castDraft(history), new ContextUndo({ count: 1 }), foldContext) ?? history;
    expect(coveredInstructions(undone, 'posix').has(key())).toBe(true);
    expect(coveredInstructions(undone, 'posix').has(key(newer))).toBe(false);
    const compacted = applyContextCompactionRecord(history, { summary: 'summary', compactedCount: history.length });
    expect(coveredInstructions(compacted, 'posix').size).toBe(0);
    expect(coveredInstructions([...compacted, snapshot(2, [file])], 'posix').has(key())).toBe(true);
  });
  it('does not supersede a different host or scope and accepts Windows aliases as one carrier', () => {
    const newer = { ...file, version: instructionVersion('changed rule') };
    const remote = { ...newer, runtimeId: 'ssh:example.test' };
    const scoped = { ...newer, scope: '/repo/other' };
    const coverage = coveredInstructions([snapshot(1, [file, remote, scoped])], 'posix');
    for (const entry of [file, remote, scoped]) expect(coverage.has(key(entry))).toBe(true);
    expect(coverage.has(key(newer))).toBe(false);
    const windows = { ...file, path: 'C:/Repo/AGENTS.md', scope: 'C:/Repo' };
    const alias = { ...newer, path: 'c:/repo/agents.md', scope: 'c:/repo' };
    expect(coveredInstructions([snapshot(1, [windows]), snapshot(2, [alias], 1)], 'win32')).toEqual(new Set([`${instructionKey(alias, 'win32')}:${alias.version}`]));
  });
  it('separates host and directory scope, normalizing Windows aliases only', () => {
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, runtimeId: 'remote' }, 'posix'));
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, scope: '/another' }, 'posix'));
    expect(instructionKey({ ...file, path: 'C:/Repo/AGENTS.md', scope: 'C:/Repo' }, 'win32')).toBe(instructionKey({ ...file, path: 'c:/repo/agents.md', scope: 'c:/repo' }, 'win32'));
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, path: '/Repo/AGENTS.md' }, 'posix'));
    expect(instructionVersion(' current\r\nrule\n')).toBe(instructionVersion('current\nrule'));
  });
});
