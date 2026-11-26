import { createHash } from 'node:crypto';
import { normalize } from 'pathe';
import type { ContextMessage } from '#/agent/contextMemory/types';

import type { InstructionFile } from '#/tool/toolContract';
export type { InstructionFile, FileReadDisclosure } from '#/tool/toolContract';

export interface InstructionAliasFile extends InstructionFile {
  readonly canonicalSourcePath: string;
}

export interface InstructionDisclosure {
  readonly files: readonly InstructionFile[];
  readonly aliases?: readonly InstructionAliasFile[];
  readonly mode: 'replace' | 'add';
}

export interface AnalyzedInstructionCoverage {
  readonly fullByVersion: ReadonlyMap<string, { readonly position: number; readonly sourcePath: string }>;
  readonly scopeByKey: ReadonlyMap<string, { readonly version: string; readonly position: number }>;
}

export type DiscoveredChainAction<T extends { readonly file: InstructionFile; readonly pathClass: 'posix' | 'win32' }> =
  | { readonly kind: 'full'; readonly item: T }
  | { readonly kind: 'alias'; readonly item: T; readonly canonicalSourcePath: string };

export function instructionVersion(content: string): string {
  return createHash('sha256').update(content.replaceAll('\r\n', '\n').trim()).digest('hex');
}

export function instructionKey(file: Pick<InstructionFile, 'path' | 'runtimeId' | 'scope'>, pathClass: 'posix' | 'win32'): string {
  const key = (path: string) => pathClass === 'win32' ? normalize(path).toLowerCase() : normalize(path);
  return `${file.runtimeId}:${key(file.path)}:${key(file.scope)}`;
}

export function analyzeInstructionCoverage(
  history: readonly ContextMessage[],
  pathClass: 'posix' | 'win32',
  systemFiles: readonly InstructionFile[] = [],
): AnalyzedInstructionCoverage {
  const fullCarriers: Array<{ file: InstructionFile; key: string; position: number; preferSourcePath: boolean }> = [];
  const aliasCarriers: Array<{ alias: InstructionAliasFile; key: string; position: number }> = [];
  const rawScopeByKey = new Map<string, { version: string; position: number }>();

  const recordFull = (file: InstructionFile, position: number, preferSourcePath = false) => {
    const key = instructionKey(file, pathClass);
    fullCarriers.push({ file, key, position, preferSourcePath });
    if ((rawScopeByKey.get(key)?.position ?? -2) < position) {
      rawScopeByKey.set(key, { version: file.version, position });
    }
  };

  const recordAlias = (alias: InstructionAliasFile, position: number) => {
    const key = instructionKey(alias, pathClass);
    aliasCarriers.push({ alias, key, position });
    if ((rawScopeByKey.get(key)?.position ?? -2) < position) {
      rawScopeByKey.set(key, { version: alias.version, position });
    }
  };

  for (const file of systemFiles) recordFull(file, -1, true);

  let snapshotFiles: readonly InstructionFile[] = [];
  let snapshotPosition = -1;
  let revision: number | undefined;
  const reads = new Map<string, { file: InstructionFile; position: number; lines: Set<number>; total?: number }>();

  for (const [position, message] of history.entries()) {
    const origin = message.origin;
    if (origin?.kind === 'injection' && origin.variant === 'runtime_snapshot') {
      const disclosure = origin.disclosure as { revision?: number; previousRevision?: number; instructions?: InstructionDisclosure } | undefined;
      if (disclosure?.previousRevision === undefined) snapshotFiles = [];
      else if (disclosure.previousRevision !== revision) { snapshotFiles = []; revision = undefined; continue; }
      revision = disclosure?.revision;
      if (disclosure?.instructions !== undefined) {
        snapshotFiles = disclosure.instructions.files;
        snapshotPosition = position;
      }
    }
    if (origin?.kind === 'injection' && origin.variant === 'agents_md') {
      const disclosure = origin.disclosure as InstructionDisclosure | undefined;
      for (const file of disclosure?.files ?? []) recordFull(file, position);
      for (const alias of disclosure?.aliases ?? []) recordAlias(alias, position);
    }
    const read = message.fileRead;
    if (message.role !== 'tool' || message.isError || read === undefined || read.truncated) continue;
    const key = instructionKey(read.file, pathClass);
    const previous = reads.get(key);
    const entry: { file: InstructionFile; position: number; lines: Set<number>; total?: number } = previous !== undefined && previous.file.version === read.file.version
      ? previous : { file: read.file, position, lines: new Set<number>() };
    entry.position = position;
    entry.total = read.totalLines ?? entry.total;
    for (let line = read.startLine; line <= read.endLine; line++) entry.lines.add(line);
    reads.set(key, entry);
  }

  for (const file of snapshotFiles) recordFull(file, snapshotPosition, true);
  for (const read of reads.values()) {
    if (read.total === undefined || read.lines.size < read.total) continue;
    if (Array.from({ length: read.total }, (_, index) => index + 1).every((line) => read.lines.has(line))) {
      recordFull(read.file, read.position);
    }
  }

  const fullStateByVersion = new Map<string, { position: number; sourcePath: string; preferred: boolean }>();
  for (const carrier of fullCarriers) {
    if (rawScopeByKey.get(carrier.key)?.version !== carrier.file.version) continue;
    const existing = fullStateByVersion.get(carrier.file.version);
    if (existing === undefined) {
      fullStateByVersion.set(carrier.file.version, {
        position: carrier.position,
        sourcePath: carrier.file.path,
        preferred: carrier.preferSourcePath,
      });
    } else {
      const takeSource = carrier.preferSourcePath && !existing.preferred;
      fullStateByVersion.set(carrier.file.version, {
        position: Math.max(existing.position, carrier.position),
        sourcePath: takeSource ? carrier.file.path : existing.sourcePath,
        preferred: existing.preferred || carrier.preferSourcePath,
      });
    }
  }

  for (const entry of aliasCarriers) {
    if (rawScopeByKey.get(entry.key)?.version !== entry.alias.version) continue;
    const existing = fullStateByVersion.get(entry.alias.version);
    if (existing !== undefined && entry.position > existing.position) {
      fullStateByVersion.set(entry.alias.version, {
        ...existing,
        position: entry.position,
      });
    }
  }

  const fullByVersion = new Map<string, { position: number; sourcePath: string }>();
  for (const [version, state] of fullStateByVersion) {
    fullByVersion.set(version, { position: state.position, sourcePath: state.sourcePath });
  }

  const scopeByKey = new Map<string, { version: string; position: number }>();
  for (const [key, entry] of rawScopeByKey) {
    if (fullByVersion.has(entry.version)) {
      scopeByKey.set(key, entry);
    }
  }

  return { fullByVersion, scopeByKey };
}

export function classifyDiscoveredChain<T extends { readonly file: InstructionFile; readonly pathClass: 'posix' | 'win32' }>(
  chain: readonly T[],
  coverage: AnalyzedInstructionCoverage,
): DiscoveredChainAction<T>[] {
  const result: DiscoveredChainAction<T>[] = [];
  let maxAncestorPos = -Infinity;
  for (const item of chain) {
    const key = instructionKey(item.file, item.pathClass);
    const exactScope = coverage.scopeByKey.get(key);
    const full = coverage.fullByVersion.get(item.file.version);

    if (full === undefined) {
      result.push({ kind: 'full', item });
      maxAncestorPos = Infinity;
      continue;
    }

    if (exactScope !== undefined && exactScope.version !== item.file.version) {
      result.push({ kind: 'alias', item, canonicalSourcePath: full.sourcePath });
      maxAncestorPos = Infinity;
      continue;
    }

    const effectivePos = Math.max(
      full.position,
      exactScope?.version === item.file.version ? exactScope.position : -Infinity,
    );

    if (effectivePos >= maxAncestorPos) {
      maxAncestorPos = effectivePos;
      continue;
    }

    result.push({ kind: 'alias', item, canonicalSourcePath: full.sourcePath });
    maxAncestorPos = Infinity;
  }
  return result;
}

export function coveredInstructions(
  history: readonly ContextMessage[],
  pathClass: 'posix' | 'win32',
  systemFiles: readonly InstructionFile[] = [],
): ReadonlySet<string> {
  const { scopeByKey } = analyzeInstructionCoverage(history, pathClass, systemFiles);
  return new Set([...scopeByKey].map(([key, entry]) => `${key}:${entry.version}`));
}
