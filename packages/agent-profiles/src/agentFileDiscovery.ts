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

  async function parseAndRegister(filePath: string, root: AgentFileRoot): Promise<void> {
    try {
      const [canonicalPath, contributionRoot] = (
        await Promise.all([fs.realpath(filePath), fs.realpath(root.path)])
      ).map((path) => path.replaceAll('\\', '/')) as [string, string];
      const text = await fs.readFile(canonicalPath);
      const agent = parseAgentFileText({
        path: canonicalPath,
        source: root.source,
        text,
        definitionId: agentProfileDefinitionId(canonicalPath),
        contributionRoot,
        warn: (message) => warn?.(message),
      });
      const prior = byName.get(agent.name);
      if (prior === undefined) {
        byName.set(agent.name, agent);
      } else if (prior.path !== agent.path) {
        const reason = `Duplicate agent profile "${agent.name}" at ${agent.path}; keeping higher-priority ${prior.path}`;
        warnCapped(agent.path, reason);
      }
    } catch (error) {
      if (isHostFsUnavailable(error)) throw error;
      if (error instanceof AgentFileParseError) {
        skipped.push({ path: filePath, reason: error.message });
        warnCapped(filePath, `Skipping invalid agent file at ${filePath}: ${error.message}`, error);
      } else {
        const reason = `Unexpected error while loading agent file: ${errorMessage(error)}`;
        skipped.push({ path: filePath, reason });
        warnCapped(filePath, `Skipping agent file at ${filePath} due to unexpected error`, error);
      }
    }
  }

  async function walk(dirPath: string, root: AgentFileRoot, depth: number): Promise<void> {
    if (depth > MAX_AGENT_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = (await fs.readdir(dirPath)).map((entry) => entry.name).toSorted();
    } catch (error) {
      if (depth > 0) {
        skipped.push({ path: dirPath, reason: `Unreadable agent directory: ${errorMessage(error)}` });
        warnCapped(dirPath, `Skipping unreadable directory ${dirPath}: ${errorMessage(error)}`, error);
        return;
      }
      if (isHostFsMissing(error)) return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry.toLowerCase() === '_private') continue;
      const entryPath = join(dirPath, entry);
      try {
        if (await isDirectoryPath(fs, entryPath)) {
          if (depth === 0 && root.lowPrioritySubdirectories?.includes(entry)) {
            deferredDirectories.push({ path: entryPath, root });
          } else {
            await walk(entryPath, root, depth + 1);
          }
          continue;
        }
        if (!entry.endsWith('.md') || !(await isFilePath(fs, entryPath))) continue;
        await parseAndRegister(entryPath, root);
      } catch (error) {
        if (isHostFsUnavailable(error)) throw error;
        if (entry.endsWith('.md')) {
          skipped.push({ path: entryPath, reason: `Unreadable agent path: ${errorMessage(error)}` });
        }
        warnCapped(entryPath, `Skipping unreadable agent path ${entryPath}: ${errorMessage(error)}`, error);
      }
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
    routes: [...byRouteId.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    skipped,
    scannedRoots: roots.map((root) => root.path),
    ...graph,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
