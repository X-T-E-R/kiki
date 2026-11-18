import { join } from 'pathe';

import { AgentFileParseError, parseAgentFileText } from './agentFile';
import { parseAgentRouteFileText } from './agentRouteFile';
import { agentProfileDefinitionId, resolveAgentSourceGraph } from './agentSourceGraph';
import type {
  AgentFileDefinition,
  AgentFileDiscoveryResult,
  AgentFileRoot,
  SkippedAgentFile,
} from './agentFileTypes';
import type { HostFs } from './hostFs';
import { isHostFsMissing, isHostFsUnavailable } from './hostFs';
import { isDirectoryPath, isFilePath } from './paths';

const MAX_AGENT_SCAN_DEPTH = 8;
const MAX_SKIP_WARNINGS = 5;
const MAX_DIR_ENTRY_CONCURRENCY = 16;

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]!);
    }
  };
  const limit = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

export interface DiscoverAgentFilesWarn {
  (message: string, error?: unknown): void;
}

export async function discoverAgentFiles(
  fs: HostFs,
  roots: readonly AgentFileRoot[],
  warn?: DiscoverAgentFilesWarn,
  options?: { readonly includeRoutes?: boolean },
): Promise<AgentFileDiscoveryResult> {
  const byName = new Map<string, AgentFileDefinition>();
  const shadowedFiles = new Map<string, string[]>();
  const byRouteId = new Map<string, AgentFileDiscoveryResult['routes'][number]>();
  const skipped: SkippedAgentFile[] = [];
  const deferredDirectories: Array<{ path: string; root: AgentFileRoot }> = [];

  let emittedWarnings = 0;
  let suppressedWarnings = 0;
  const suppressedSubjects: string[] = [];
  const warnCapped = (subject: string, message: string, error?: unknown): void => {
    if (emittedWarnings < MAX_SKIP_WARNINGS) {
      emittedWarnings += 1;
      warn?.(message, error);
    } else {
      suppressedWarnings += 1;
      if (suppressedSubjects.length < 3) suppressedSubjects.push(subject);
    }
  };

  type ReadFileOutcome =
    | {
        readonly kind: 'agent';
        readonly filePath: string;
        readonly agent: AgentFileDefinition;
        readonly parseWarnings: readonly string[];
      }
    | {
        readonly kind: 'parse_error';
        readonly filePath: string;
        readonly error: AgentFileParseError;
      }
    | {
        readonly kind: 'unexpected_error';
        readonly filePath: string;
        readonly error: unknown;
      };

  const rootCanonicalPromises = new Map<AgentFileRoot, Promise<string>>();
  const canonicalRootOf = (root: AgentFileRoot): Promise<string> => {
    let promise = rootCanonicalPromises.get(root);
    if (promise === undefined) {
      promise = fs.realpath(root.path).then((p) => p.replaceAll('\\', '/'));
      void promise.catch(() => undefined);
      rootCanonicalPromises.set(root, promise);
    }
    return promise;
  };

  async function loadAgentEntry(
    filePath: string,
    root: AgentFileRoot,
  ): Promise<ReadFileOutcome> {
    try {
      const [canonicalRaw, contributionRoot] = await Promise.all([
        fs.realpath(filePath),
        canonicalRootOf(root),
      ]);
      const canonicalPath = canonicalRaw.replaceAll('\\', '/');
      const text = await fs.readFile(canonicalPath);
      const parseWarnings: string[] = [];
      const agent = parseAgentFileText({
        path: canonicalPath,
        source: root.source,
        text,
        definitionId: agentProfileDefinitionId(canonicalPath),
        contributionRoot,
        warn: (message) => parseWarnings.push(message),
      });
      return { kind: 'agent', filePath, agent, parseWarnings };
    } catch (error) {
      if (isHostFsUnavailable(error)) throw error;
      if (error instanceof AgentFileParseError) {
        return { kind: 'parse_error', filePath, error };
      }
      return { kind: 'unexpected_error', filePath, error };
    }
  }

  function registerLoadedAgent(outcome: ReadFileOutcome): void {
    if (outcome.kind === 'parse_error') {
      skipped.push({ path: outcome.filePath, reason: outcome.error.message });
      warnCapped(
        outcome.filePath,
        `Skipping invalid agent file at ${outcome.filePath}: ${outcome.error.message}`,
        outcome.error,
      );
      return;
    }
    if (outcome.kind === 'unexpected_error') {
      const reason = `Unexpected error while loading agent file: ${errorMessage(outcome.error)}`;
      skipped.push({ path: outcome.filePath, reason });
      warnCapped(outcome.filePath, `Skipping agent file at ${outcome.filePath} due to unexpected error`, outcome.error);
      return;
    }
    for (const message of outcome.parseWarnings) {
      warn?.(message);
    }
    const { agent } = outcome;
    const prior = byName.get(agent.name);
    if (prior === undefined) {
      byName.set(agent.name, agent);
    } else if (prior.path !== agent.path) {
      const paths = shadowedFiles.get(prior.definitionId) ?? [];
      paths.push(agent.path);
      shadowedFiles.set(prior.definitionId, paths);
      const reason = `Duplicate agent profile "${agent.name}" at ${agent.path}; keeping higher-priority ${prior.path}`;
      warnCapped(agent.path, reason);
    }
  }

  async function walk(
    dirPath: string,
    root: AgentFileRoot,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dirPath)).map((entry) => entry.name).toSorted();
    } catch (error) {
      if (isHostFsUnavailable(error)) throw error;
      if (depth > 0) {
        skipped.push({ path: dirPath, reason: `Unreadable agent directory: ${errorMessage(error)}` });
        warnCapped(dirPath, `Skipping unreadable directory ${dirPath}: ${errorMessage(error)}`, error);
        return;
      }
      if (isHostFsMissing(error)) return;
      throw error;
    }

    type WalkEntryPlan =
      | { readonly kind: 'skip' }
      | { readonly kind: 'dir'; readonly entry: string; readonly entryPath: string }
      | { readonly kind: 'file'; readonly outcome: ReadFileOutcome }
      | { readonly kind: 'error'; readonly entry: string; readonly entryPath: string; readonly error: unknown };

    const candidates = entries.filter(
      (entry) => !entry.startsWith('.') && entry !== 'node_modules' && entry.toLowerCase() !== '_private',
    );
    const inspected = await mapBounded(
      candidates,
      MAX_DIR_ENTRY_CONCURRENCY,
      async (entry): Promise<WalkEntryPlan> => {
        const entryPath = join(dirPath, entry);
        try {
          if (await isDirectoryPath(fs, entryPath)) {
            return { kind: 'dir', entry, entryPath };
          }
          if (!entry.endsWith('.md') || !(await isFilePath(fs, entryPath))) {
            return { kind: 'skip' };
          }
          return {
            kind: 'file',
            outcome: await loadAgentEntry(entryPath, root),
          };
        } catch (error) {
          if (isHostFsUnavailable(error)) throw error;
          return { kind: 'error', entry, entryPath, error };
        }
      },
    );

    for (const item of inspected) {
      if (item.kind === 'skip') continue;
      if (item.kind === 'error') {
        if (item.entry.endsWith('.md')) {
          skipped.push({ path: item.entryPath, reason: `Unreadable agent path: ${errorMessage(item.error)}` });
        }
        warnCapped(item.entryPath, `Skipping unreadable agent path ${item.entryPath}: ${errorMessage(item.error)}`, item.error);
        continue;
      }
      if (item.kind === 'dir') {
        if (depth === 0 && root.lowPrioritySubdirectories?.includes(item.entry)) {
          deferredDirectories.push({ path: item.entryPath, root });
        } else {
          await walk(item.entryPath, root, depth + 1);
        }
        continue;
      }
      registerLoadedAgent(item.outcome);
    }
  }

  async function discoverRoutes(root: AgentFileRoot): Promise<void> {
    const routesRoot = join(root.path, '.routes');
    let profiles: readonly string[];
    try {
      profiles = (await fs.readdir(routesRoot)).map((entry) => entry.name).toSorted();
    } catch (error) {
      if (isHostFsMissing(error)) return;
      throw error;
    }
    for (const profile of profiles) {
      const profileDir = join(routesRoot, profile);
      if (!(await isDirectoryPath(fs, profileDir))) continue;
      let entries: readonly string[];
      try {
        entries = (await fs.readdir(profileDir)).map((entry) => entry.name).toSorted();
      } catch (error) {
        warnCapped(profileDir, `Skipping unreadable route directory ${profileDir}: ${errorMessage(error)}`, error);
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const path = join(profileDir, entry);
        try {
          if (!(await isFilePath(fs, path))) continue;
          const route = parseAgentRouteFileText({
            path,
            expectedProfile: profile,
            expectedRouteName: entry.slice(0, -3),
            text: await fs.readFile(path),
            warn: (message) => warn?.(message),
          });
          const prior = byRouteId.get(route.id);
          if (prior !== undefined) {
            const reason = `Duplicate route id "${route.id}" in the same source; keeping ${prior.path}`;
            skipped.push({ path, reason, code: 'agent_profile_route.duplicate' });
            warnCapped(path, `Skipping duplicate agent route at ${path}: ${reason}`);
            continue;
          }
          byRouteId.set(route.id, route);
        } catch (error) {
          if (isHostFsUnavailable(error)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          skipped.push({ path, reason, code: 'agent_profile_route.invalid_sidecar' });
          warnCapped(path, `Skipping invalid agent route at ${path}: ${reason}`, error);
        }
      }
    }
  }

  for (const root of roots) {
    try {
      await walk(root.path, root, 0);
      if (options?.includeRoutes === true) await discoverRoutes(root);
    } catch (error) {
      if (isHostFsUnavailable(error)) throw error;
      warnCapped(root.path, `Skipping unreadable agent root ${root.path}: ${errorMessage(error)}`, error);
    }
  }

  for (const { path, root } of deferredDirectories) {
    await walk(path, root, 1);
  }

  if (suppressedWarnings > 0) {
    const examples = suppressedSubjects.map((subject) => `"${subject}"`).join(', ');
    warn?.(
      `Suppressed ${suppressedWarnings} further agent-discovery skip warnings (e.g. ${examples}); fix or remove the offending files/directories to silence them`,
    );
  }

  const agents = [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  const graph = await resolveAgentSourceGraph(fs, agents, (message, error) => {
    warnCapped(message, message, error);
  });
  return {
    agents,
    shadowedFiles,
    routes: [...byRouteId.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    skipped,
    scannedRoots: roots.map((root) => root.path),
    ...graph,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
