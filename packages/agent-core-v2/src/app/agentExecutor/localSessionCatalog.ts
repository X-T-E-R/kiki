import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'pathe';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { IHostFileSystem, type HostDirEntry, type HostFileStat } from '#/os/interface/hostFileSystem';

import { IAgentExecutorRegistry } from './agentExecutor';
import { executorProcessEnv } from './executorOverrides';
import { parseLocalSession, type LocalSessionEngine, type LocalSessionMessage } from './localSessionParser';

const MAX_CANDIDATES = 10_000;
const PREVIEW_BYTES = 256 * 1024;
const DETAIL_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 1_000;

export interface LocalSessionSummary {
  /** Namespaced source identity. Never pass this to ISessionManager or ISessionIndex. */
  readonly id: string;
  readonly engine: LocalSessionEngine;
  readonly externalId: string;
  readonly sourcePath: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt: string;
  readonly lastPrompt?: string;
  readonly parentId?: string;
  readonly partial: boolean;
}
export interface LocalSessionDetail {
  readonly summary: LocalSessionSummary;
  readonly messages: readonly LocalSessionMessage[];
  readonly warnings: readonly string[];
}
export interface LocalSessionDirectory {
  readonly root: string;
  readonly exists: boolean;
  readonly items: readonly LocalSessionSummary[];
  readonly truncated: boolean;
  readonly unreadableFiles: number;
}
export interface ILocalSessionCatalog {
  readonly _serviceBrand: undefined;
  list(executorId: string, limit?: number): Promise<LocalSessionDirectory>;
  get(executorId: string, id: string): Promise<LocalSessionDetail | undefined>;
}
export const ILocalSessionCatalog: ServiceIdentifier<ILocalSessionCatalog> =
  createDecorator<ILocalSessionCatalog>('localSessionCatalog');

export function localSessionEngine(executorId: string): LocalSessionEngine | undefined {
  if (executorId === 'claude-acp') return 'claude';
  if (executorId === 'codex-app-server' || executorId === 'codex-acp') return 'codex';
  return undefined;
}
interface Candidate {
  readonly path: string;
  readonly identity: string;
  readonly externalId: string;
  readonly recency: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Read-only, bounded vendor transcript catalog, deliberately separate from Kiki's session index. */
export class LocalSessionCatalog implements ILocalSessionCatalog {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IAgentExecutorRegistry private readonly registry: IAgentExecutorRegistry,
  ) {}

  async list(executorId: string, limit = 100): Promise<LocalSessionDirectory> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error2(ErrorCodes.CONFIG_INVALID, 'Local session limit must be an integer between 1 and 200');
    }
    const { engine, root, exists, candidates, truncated } = await this.scan(executorId);
    const items: LocalSessionSummary[] = [];
    let unreadableFiles = 0;
    for (const candidate of candidates) {
      if (items.length >= limit) break;
      try {
        const detail = await this.read(engine, root, candidate, PREVIEW_BYTES);
        if (detail !== undefined) items.push(detail.summary);
      } catch (error) {
        if (isFileReadError(error)) unreadableFiles += 1;
        else throw error;
      }
    }
    return { root, exists, items, unreadableFiles,
      truncated: truncated || candidates.length > items.length + unreadableFiles };
  }

  async get(executorId: string, id: string): Promise<LocalSessionDetail | undefined> {
    const engine = localSessionEngine(executorId);
    if (engine === undefined) throw unsupportedExecutor(executorId);
    if (!new RegExp(`^external:${engine}:[a-f0-9]{64}$`).test(id)) return undefined;
    const { root, candidates } = await this.scan(executorId);
    const candidate = candidates.find((item) => sourceId(engine, root, item.identity) === id);
    return candidate === undefined ? undefined : this.read(engine, root, candidate, DETAIL_BYTES);
  }

  private async scan(executorId: string) {
    const engine = localSessionEngine(executorId);
    const descriptor = this.registry.get(executorId);
    if (engine === undefined || descriptor === undefined) throw unsupportedExecutor(executorId);
    const homeVar = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    const home = executorProcessEnv(descriptor)?.[homeVar]?.trim() || this.bootstrap.getEnv(homeVar)?.trim()
      || join(this.bootstrap.osHomeDir, engine === 'claude' ? '.claude' : '.codex');
    const configuredRoot = join(resolve(home), engine === 'claude' ? 'projects' : 'sessions');
    let root: string;
    try { root = await this.fs.realpath(configuredRoot); }
    catch (error) {
      if (isNotFound(error)) return { engine, root: configuredRoot, exists: false,
        candidates: [] as Candidate[], truncated: false };
      throw error;
    }
    const candidates: Candidate[] = [];
    let scanned = 0;
    let truncated = false;
    const visit = async (directory: string, depth: number): Promise<void> => {
      let entries: readonly HostDirEntry[];
      try { entries = await this.fs.readdir(directory); }
      catch (error) { if (isNotFound(error)) return; throw error; }
      for (const entry of entries.toSorted((a, b) => b.name.localeCompare(a.name))) {
        if (++scanned > MAX_CANDIDATES) { truncated = true; return; }
        if (entry.isSymbolicLink === true) continue;
        const path = join(directory, entry.name);
        const rel = relative(root, path);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) continue;
        // A directory can be replaced with a junction during a scan. Canonicalize
        // before reading and require it to remain inside this transcript root.
        let canonical: string;
        try { canonical = await this.fs.realpath(path); }
        catch (error) { if (isNotFound(error)) continue; throw error; }
        const canonicalRel = relative(root, canonical);
        if (isAbsolute(canonicalRel) || canonicalRel === '..' || canonicalRel.startsWith('../')) continue;
        if (entry.isDirectory && depth < (engine === 'claude' ? 1 : 3)) {
          await visit(canonical, depth + 1);
          if (truncated) return;
        } else if (entry.isFile && entry.name.endsWith('.jsonl')) {
          const filename = engine === 'claude' ? entry.name.slice(0, -6) :
            entry.name.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/)?.[2];
          if (filename === undefined || filename.startsWith('agent-')) continue;
          const externalId = engine === 'codex' ? filename.split('_')[0]! : filename;
          let info: HostFileStat;
          try { info = await this.fs.stat(canonical); }
          catch (error) { if (isNotFound(error)) continue; throw error; }
          if (!info.isFile) continue;
          candidates.push({ path: canonical, identity: engine === 'codex' ? externalId : rel,
            externalId, recency: entry.name, size: info.size, mtimeMs: info.mtimeMs ?? 0 });
        }
      }
    };
    await visit(root, 0);
    // A Codex revert leaves immutable old rollouts on disk. Select the newest
    // filename timestamp/rollout id per thread, matching Codeg's parser.
    const current = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const old = current.get(candidate.identity);
      if (old === undefined || old.recency < candidate.recency) current.set(candidate.identity, candidate);
    }
    return { engine, root, exists: true, truncated,
      candidates: [...current.values()].toSorted((a, b) => b.mtimeMs - a.mtimeMs || b.recency.localeCompare(a.recency)) };
  }

  private async read(engine: LocalSessionEngine, root: string, candidate: Candidate, budget: number): Promise<LocalSessionDetail | undefined> {
    const head = await this.fs.readBytes(candidate.path, Math.min(candidate.size, budget));
    let input = Buffer.from(head).toString('utf8');
    const warnings: string[] = [];
    if (candidate.size > budget) {
      const headBytes = Math.min(PREVIEW_BYTES / 2, budget / 2);
      const tailBytes = budget - headBytes;
      const tail = Buffer.from(await this.fs.readBytes(candidate.path, tailBytes, candidate.size - tailBytes)).toString('utf8');
      const prefix = Buffer.from(head.subarray(0, headBytes)).toString('utf8');
      input = prefix.slice(0, prefix.lastIndexOf('\n') + 1) + tail.slice(tail.indexOf('\n') + 1);
      warnings.push('transcript_sampled');
    }
    const parsed = parseLocalSession(engine, input);
    if (parsed.externalId === undefined && parsed.messages.length === 0) return undefined;
    if (parsed.externalId !== undefined && parsed.externalId !== candidate.externalId) warnings.push('source_identity_mismatch');
    warnings.push(...parsed.warnings);
    if (parsed.messages.length > MAX_MESSAGES) warnings.push('messages_truncated');
    const summary: LocalSessionSummary = {
      id: sourceId(engine, root, candidate.identity), engine,
      externalId: parsed.externalId ?? candidate.externalId, sourcePath: candidate.path,
      cwd: parsed.cwd, title: parsed.title, createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt ?? new Date(candidate.mtimeMs).toISOString(),
      lastPrompt: parsed.lastPrompt, parentId: parsed.parentId,
      partial: warnings.length > 0,
    };
    return { summary, messages: parsed.messages.slice(-MAX_MESSAGES), warnings: [...new Set(warnings)] };
  }
}
function sourceId(engine: LocalSessionEngine, root: string, identity: string): string {
  return `external:${engine}:${createHash('sha256').update(`${root}\0${identity}`).digest('hex')}`;
}
function unsupportedExecutor(id: string): Error2 {
  return new Error2(ErrorCodes.CONFIG_INVALID, `Executor "${id}" has no supported local session catalog`);
}
function isNotFound(error: unknown): boolean {
  return error instanceof Error2 && error.code === 'os.fs.not_found';
}
function isFileReadError(error: unknown): boolean {
  return error instanceof Error2 && ['os.fs.not_found', 'os.fs.permission_denied', 'os.fs.unavailable'].includes(error.code);
}
registerScopedService(LifecycleScope.App, ILocalSessionCatalog, LocalSessionCatalog,
  ScopeActivation.OnScopeCreated, 'localExecutorSessions');
