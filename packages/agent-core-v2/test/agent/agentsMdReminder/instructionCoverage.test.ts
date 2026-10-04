import { describe, expect, it } from 'vitest';
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
  it('keeps independent complete disclosure/Read carriers when a snapshot removes its own carrier', () => {
    const full: ContextMessage = { role: 'user', content: [], toolCalls: [], origin: { kind: 'injection', variant: 'agents_md', disclosure: { mode: 'add', files: [file] } } };
    expect(coveredInstructions([full, snapshot(1, [])], 'posix').has(key())).toBe(true);
    expect(coveredInstructions([read(1, 3), snapshot(1, [])], 'posix').has(key())).toBe(true);
    expect(coveredInstructions([], 'posix').size).toBe(0);
  });
  it('separates host and directory scope, normalizing Windows aliases only', () => {
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, runtimeId: 'remote' }, 'posix'));
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, scope: '/another' }, 'posix'));
    expect(instructionKey({ ...file, path: 'C:/Repo/AGENTS.md', scope: 'C:/Repo' }, 'win32')).toBe(instructionKey({ ...file, path: 'c:/repo/agents.md', scope: 'c:/repo' }, 'win32'));
    expect(instructionKey(file, 'posix')).not.toBe(instructionKey({ ...file, path: '/Repo/AGENTS.md' }, 'posix'));
    expect(instructionVersion(' current\r\nrule\n')).toBe(instructionVersion('current\nrule'));
  });
});
