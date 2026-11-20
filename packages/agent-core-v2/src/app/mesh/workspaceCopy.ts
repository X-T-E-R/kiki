import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { MeshWorkspaceCopyStrategy } from '@kiki/protocol';

import type { ISessionApprovalService } from '#/session/approval/approval';
import type { HumanTakeoverManager } from './humanTakeover';
import { evaluateMeshApproval, type MeshPermissionMode } from './meshApproval';

const execFileAsync = promisify(execFile);

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'target', '.kiki-cow-meta']);

export interface WorkspaceCopyRecord {
  readonly copyId: string;
  readonly nodeId: string;
  readonly sourceRoot: string;
  readonly copyPath: string;
  readonly strategy: MeshWorkspaceCopyStrategy;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly baseInventory: Readonly<Record<string, string>>;
  readonly snapshots: readonly WorkspaceCopySnapshot[];
}

export interface WorkspaceCopySnapshot {
  readonly snapshotId: string;
  readonly createdAt: number;
  readonly label?: string;
  readonly digest: string;
  readonly fileCount: number;
}

export interface WorkspaceCopyStatus {
  readonly copyId: string;
  readonly strategy: MeshWorkspaceCopyStrategy;
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly dirty: boolean;
}

export interface WorkspaceCopyApplyResult {
  readonly copyId: string;
  readonly appliedFiles: readonly string[];
  readonly deletedFiles: readonly string[];
  readonly approvalVia: 'yolo_auto_approve' | 'session_approval_service';
}

export interface CreateWorkspaceCopyOptions {
  readonly sourceRoot: string;
  readonly nodeId?: string;
  readonly copyId?: string;
}

export interface ApplyWorkspaceCopyOptions {
  readonly permissionMode?: MeshPermissionMode;
  readonly approvalService?: Pick<ISessionApprovalService, 'request'>;
  readonly sessionId?: string;
  readonly takeoverManager?: HumanTakeoverManager;
  readonly targetId?: string;
  readonly overrideHumanLease?: boolean;
  readonly deleteRemoved?: boolean;
}

/**
 * Manages isolated zero-copy / COW workspace copies (`cp -c` on macOS APFS, `cp --reflink=auto` on Linux,
 * `git worktree` on Windows with clean directory fallback) supporting `status`, `diff`, `snapshot`, and `apply`.
 */
export class WorkspaceCopyManager {
  private readonly metaDir: string;
  private readonly copiesDir: string;

  constructor(
    baseDir: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.metaDir = join(resolve(baseDir), 'meta');
    this.copiesDir = join(resolve(baseDir), 'copies');
  }

  async createCopy(options: CreateWorkspaceCopyOptions): Promise<WorkspaceCopyRecord> {
    const sourceRoot = resolve(options.sourceRoot);
    const copyId = options.copyId ?? `copy_${randomUUID().slice(0, 12)}`;
    if (!/^[a-zA-Z0-9._-]+$/.test(copyId)) {
      throw new Error(`Invalid workspace copy id: ${copyId}`);
    }
    await mkdir(this.metaDir, { recursive: true });
    await mkdir(this.copiesDir, { recursive: true });
    const copyPath = join(this.copiesDir, copyId);

    const strategy = await this.materializeCopy(sourceRoot, copyPath);
    const baseInventory = await scanFileHashes(copyPath);
    const now = Date.now();
    const record: WorkspaceCopyRecord = {
      copyId,
      nodeId: options.nodeId ?? 'local',
      sourceRoot,
      copyPath,
      strategy,
      createdAt: now,
      updatedAt: now,
      baseInventory,
      snapshots: [],
    };
    await this.saveRecord(record);
    return record;
  }

  async getCopy(copyId: string): Promise<WorkspaceCopyRecord | undefined> {
    try {
      const raw = await readFile(this.metaPath(copyId), 'utf8');
      return JSON.parse(raw) as WorkspaceCopyRecord;
    } catch {
      return undefined;
    }
  }

  async listCopies(): Promise<readonly WorkspaceCopyRecord[]> {
    try {
      const names = await readdir(this.metaDir);
      const records: WorkspaceCopyRecord[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const copyId = name.slice(0, -'.json'.length);
        const record = await this.getCopy(copyId);
        if (record !== undefined) records.push(record);
      }
      return records.toSorted((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  }

  async status(copyId: string): Promise<WorkspaceCopyStatus> {
    const record = await this.requireCopy(copyId);
    const current = await scanFileHashes(record.copyPath);
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [relPath, hash] of Object.entries(current)) {
      const baseHash = record.baseInventory[relPath];
      if (baseHash === undefined) added.push(relPath);
      else if (baseHash !== hash) modified.push(relPath);
    }
    for (const relPath of Object.keys(record.baseInventory)) {
      if (!Object.hasOwn(current, relPath)) deleted.push(relPath);
    }
    added.sort();
    modified.sort();
    deleted.sort();
    return {
      copyId,
      strategy: record.strategy,
      added,
      modified,
      deleted,
      dirty: added.length > 0 || modified.length > 0 || deleted.length > 0,
    };
  }

  async diff(copyId: string): Promise<string> {
    const record = await this.requireCopy(copyId);
    if (record.strategy === 'git_worktree') {
      const gitDiff = await runCommand('git', ['diff', '--no-ext-diff'], record.copyPath);
      const statusInfo = await this.status(copyId);
      const extraLines: string[] = [];
      for (const addedPath of statusInfo.added) {
        const content = await readFile(join(record.copyPath, addedPath), 'utf8').catch(() => '<binary>');
        extraLines.push(`diff --git a/${addedPath} b/${addedPath}\nnew file\n+++ b/${addedPath}\n${prefixLines(content, '+')}`);
      }
      const chunks = [gitDiff?.trim() ?? '', ...extraLines].filter((part) => part.length > 0);
      return chunks.join('\n');
    }

    const statusInfo = await this.status(copyId);
    const hunks: string[] = [];
    for (const relPath of [...statusInfo.added, ...statusInfo.modified]) {
      const srcContent = await readFile(join(record.sourceRoot, relPath), 'utf8').catch(() => undefined);
      const dstContent = await readFile(join(record.copyPath, relPath), 'utf8').catch(() => '');
      hunks.push(
        `--- a/${relPath}\n+++ b/${relPath}\n${srcContent === undefined ? '' : `${prefixLines(srcContent, '-')}\n`}${prefixLines(dstContent, '+')}`,
      );
    }
    for (const relPath of statusInfo.deleted) {
      const srcContent = await readFile(join(record.sourceRoot, relPath), 'utf8').catch(() => '');
      hunks.push(`--- a/${relPath}\n+++ /dev/null\n${prefixLines(srcContent, '-')}`);
    }
    return hunks.join('\n');
  }

  async snapshot(copyId: string, label?: string): Promise<WorkspaceCopySnapshot> {
    const record = await this.requireCopy(copyId);
    const current = await scanFileHashes(record.copyPath);
    const ordered = Object.entries(current).toSorted(([a], [b]) => a.localeCompare(b));
    const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
    const snap: WorkspaceCopySnapshot = {
      snapshotId: `snap_${randomUUID().slice(0, 10)}`,
      createdAt: Date.now(),
      ...(label === undefined ? {} : { label }),
      digest,
      fileCount: ordered.length,
    };
    const next: WorkspaceCopyRecord = {
      ...record,
      updatedAt: snap.createdAt,
      snapshots: [...record.snapshots, snap],
    };
    await this.saveRecord(next);
    return snap;
  }

  async apply(copyId: string, options: ApplyWorkspaceCopyOptions = {}): Promise<WorkspaceCopyApplyResult> {
    const record = await this.requireCopy(copyId);
    if (options.takeoverManager !== undefined) {
      options.takeoverManager.assertWritable(options.targetId ?? record.nodeId, {
        overrideHumanLease: options.overrideHumanLease,
      });
    }
    const approval = await evaluateMeshApproval({
      operation: 'cow_apply',
      permissionMode: options.permissionMode ?? 'auto',
      action: `Apply workspace copy '${copyId}' back to '${record.sourceRoot}'`,
      targetLabel: record.nodeId,
      sessionId: options.sessionId,
      approvalService: options.approvalService,
    });
    if (approval.decision !== 'approved') {
      throw new Error(approval.feedback ?? `Workspace copy apply rejected (${approval.decision})`);
    }

    const currentStatus = await this.status(copyId);
    const appliedFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const relPath of [...currentStatus.added, ...currentStatus.modified]) {
      const srcFile = join(record.copyPath, relPath);
      const dstFile = join(record.sourceRoot, relPath);
      await mkdir(dirname(dstFile), { recursive: true });
      await copyFile(srcFile, dstFile);
      appliedFiles.push(relPath);
    }
    if (options.deleteRemoved !== false) {
      for (const relPath of currentStatus.deleted) {
        await rm(join(record.sourceRoot, relPath), { force: true });
        deletedFiles.push(relPath);
      }
    }

    const updatedInventory = await scanFileHashes(record.copyPath);
    await this.saveRecord({
      ...record,
      updatedAt: Date.now(),
      baseInventory: updatedInventory,
    });

    return {
      copyId,
      appliedFiles,
      deletedFiles,
      approvalVia: approval.via === 'yolo_auto_approve' ? 'yolo_auto_approve' : 'session_approval_service',
    };
  }

  async removeCopy(copyId: string): Promise<boolean> {
    const record = await this.getCopy(copyId);
    if (record === undefined) return false;
    if (record.strategy === 'git_worktree') {
      await runCommand('git', ['worktree', 'remove', '--force', record.copyPath], record.sourceRoot);
    }
    await rm(record.copyPath, { recursive: true, force: true });
    await rm(this.metaPath(copyId), { force: true });
    return true;
  }

  private async materializeCopy(
    sourceRoot: string,
    copyPath: string,
  ): Promise<MeshWorkspaceCopyStrategy> {
    const isGitRepo = (await runCommand('git', ['rev-parse', '--is-inside-work-tree'], sourceRoot)) === 'true';

    if (this.platform === 'darwin') {
      const cloned = await runCommand('cp', ['-cR', sourceRoot, copyPath], dirname(copyPath));
      if (cloned !== undefined) return 'apfs_clone';
    }
    if (this.platform === 'linux') {
      const cloned = await runCommand('cp', ['-a', '--reflink=auto', sourceRoot, copyPath], dirname(copyPath));
      if (cloned !== undefined) return 'reflink';
    }
    if (isGitRepo) {
      const added = await runCommand(
        'git',
        ['worktree', 'add', '--detach', '--force', copyPath, 'HEAD'],
        sourceRoot,
      );
      if (added !== undefined) {
        await overlayWorkingTreeChanges(sourceRoot, copyPath);
        return 'git_worktree';
      }
    }
    await copyDirectoryFiltered(sourceRoot, copyPath);
    return 'copy_fallback';
  }

  private async requireCopy(copyId: string): Promise<WorkspaceCopyRecord> {
    const record = await this.getCopy(copyId);
    if (record === undefined) throw new Error(`Workspace copy '${copyId}' not found`);
    return record;
  }

  private metaPath(copyId: string): string {
    return join(this.metaDir, `${copyId}.json`);
  }

  private async saveRecord(record: WorkspaceCopyRecord): Promise<void> {
    await writeFile(this.metaPath(record.copyId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}

async function overlayWorkingTreeChanges(sourceRoot: string, copyPath: string): Promise<void> {
  const statusOut = await runCommand('git', ['status', '--porcelain=v1', '-z'], sourceRoot, false);
  if (statusOut === undefined || statusOut.length === 0) return;
  const tokens = statusOut.split('\0').filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]!;
    const xy = entry.slice(0, 2);
    const relPath = entry.slice(3);
    if (xy.startsWith('R') || xy.startsWith('C')) index += 1;
    if (relPath === '' || relPath.split(/[\\/]/).some((seg) => EXCLUDED_DIRS.has(seg))) continue;
    const src = join(sourceRoot, relPath);
    const dst = join(copyPath, relPath);
    if (xy.includes('D')) {
      await rm(dst, { force: true });
    } else {
      const info = await stat(src).catch(() => undefined);
      if (info?.isFile()) {
        await mkdir(dirname(dst), { recursive: true });
        await copyFile(src, dst);
      }
    }
  }
}

async function copyDirectoryFiltered(srcDir: string, dstDir: string): Promise<void> {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryFiltered(src, dst);
    } else if (entry.isFile()) {
      await copyFile(src, dst);
    }
  }
}

async function scanFileHashes(rootDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const rel = relative(rootDir, fullPath).replaceAll('\\', '/');
        const bytes = await readFile(fullPath);
        result[rel] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  };
  await walk(rootDir);
  return result;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

async function runCommand(
  cmd: string,
  args: readonly string[],
  cwd: string,
  trim = true,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, [...args], {
      cwd,
      timeout: 30_000,
      windowsHide: true,
    });
    return trim ? stdout.trim() : stdout;
  } catch {
    return undefined;
  }
}
