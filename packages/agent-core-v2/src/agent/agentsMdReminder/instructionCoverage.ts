import { createHash } from 'node:crypto';
import { normalize } from 'pathe';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { InstructionFile } from '#/tool/toolContract';
export type { InstructionFile, FileReadDisclosure } from '#/tool/toolContract';

export interface InstructionDisclosure {
  readonly files: readonly InstructionFile[];
  readonly mode: 'replace' | 'add';
}

export function instructionVersion(content: string): string {
  return createHash('sha256').update(content.replaceAll('\r\n', '\n').trim()).digest('hex');
}

export function instructionKey(file: Pick<InstructionFile, 'path' | 'runtimeId' | 'scope'>, pathClass: 'posix' | 'win32'): string {
  const key = (path: string) => pathClass === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  return `${file.runtimeId}:${key(file.path)}:${key(file.scope)}`;
}

export function coveredInstructions(history: readonly ContextMessage[], pathClass: 'posix' | 'win32'): ReadonlySet<string> {
  const coverage = new Set<string>();
  let snapshotFiles: readonly InstructionFile[] = [];
  let revision: number | undefined;
  const reads = new Map<string, { version: string; lines: Set<number>; total?: number }>();
  for (const message of history) {
    const origin = message.origin;
    if (origin?.kind === 'injection' && origin.variant === 'runtime_snapshot') {
      const disclosure = origin.disclosure as { revision?: number; previousRevision?: number; instructions?: InstructionDisclosure } | undefined;
      if (disclosure?.previousRevision === undefined) snapshotFiles = [];
      else if (disclosure.previousRevision !== revision) { snapshotFiles = []; revision = undefined; continue; }
      revision = disclosure?.revision;
      if (disclosure?.instructions !== undefined) snapshotFiles = disclosure.instructions.files;
    }
    if (origin?.kind === 'injection' && origin.variant === 'agents_md') {
      const disclosure = origin.disclosure as InstructionDisclosure | undefined;
      for (const file of disclosure?.files ?? []) coverage.add(`${instructionKey(file, pathClass)}:${file.version}`);
    }
    const read = message.fileRead;
    if (message.role !== 'tool' || message.isError || read === undefined || read.truncated) continue;
    const key = instructionKey(read.file, pathClass);
    const previous = reads.get(key);
    const entry: { version: string; lines: Set<number>; total?: number } = previous !== undefined && previous.version === read.file.version
      ? previous : { version: read.file.version, lines: new Set<number>() };
    entry.total = read.totalLines ?? entry.total;
    for (let line = read.startLine; line <= read.endLine; line++) entry.lines.add(line);
    reads.set(key, entry);
  }
  for (const file of snapshotFiles) coverage.add(`${instructionKey(file, pathClass)}:${file.version}`);
  for (const [key, read] of reads) {
    if (read.total === undefined || read.lines.size < read.total) continue;
    if (Array.from({ length: read.total }, (_, index) => index + 1).every((line) => read.lines.has(line))) coverage.add(`${key}:${read.version}`);
  }
  return coverage;
}
