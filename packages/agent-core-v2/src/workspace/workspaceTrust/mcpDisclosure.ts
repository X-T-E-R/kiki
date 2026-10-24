import { loadAgentsMdForRoots } from '#/agent/profile/context';
import { projectRoots } from '#/app/skillCatalog/skillRoots';
import { loadMcpServersDetailed, resolveMcpJsonPaths, type ResolveMcpJsonPathsInput } from '#/app/mcpConfig/configLoader';
import type { ProjectAdditionalDirsLoadResult } from '#/app/projectLocalConfig/projectLocalConfig';
import { projectAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';

export interface WorkspaceTrustMcpTarget {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly origin: string;
}

export interface WorkspaceTrustSources {
  readonly gatedMcpServers: readonly WorkspaceTrustMcpTarget[];
  readonly additionalDirs: readonly string[];
  readonly additionalDirSources: readonly string[];
  readonly instructionSources: {
    readonly agentsMdPaths: readonly string[];
    readonly skills: readonly string[];
    readonly agentProfiles: readonly string[];
  };
  readonly warnings: readonly string[];
}

export async function describeWorkspaceTrustSources(input: ResolveMcpJsonPathsInput & {
  readonly osHomeDir: string;
  readonly readAdditionalDirs: (cwd: string) => Promise<ProjectAdditionalDirsLoadResult>;
}): Promise<WorkspaceTrustSources> {
  const warnings: string[] = [];
  const inspect = async <T>(label: string, read: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await read();
    } catch {
      warnings.push(`Could not inspect ${label}. Check the project files before trusting this folder.`);
      return empty;
    }
  };
  const [gatedMcpServers, dirs, instructions, skills, profiles] = await Promise.all([
    inspect('MCP configuration', async () => {
      const [paths, loaded] = await Promise.all([resolveMcpJsonPaths(input), loadMcpServersDetailed({ ...input, includeProject: true })]);
      const projectPaths = new Set([paths.projectRoot, paths.project]);
      return Object.entries(loaded.servers)
        .filter(([name, config]) => projectPaths.has(loaded.origins[name] ?? '') && config.enabled !== false)
        .map(([name, config]): WorkspaceTrustMcpTarget => {
          const origin = loaded.origins[name]!;
          return config.transport === 'stdio'
            ? { name, transport: config.transport, command: config.command, args: config.args, cwd: config.cwd, origin }
            : { name, transport: config.transport, url: config.url, origin };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));
    }, []),
    inspect('additional directories', () => input.readAdditionalDirs(input.cwd), undefined),
    inspect('AGENTS.md instructions', () => loadAgentsMdForRoots({ fs: input.fs, homeDir: input.osHomeDir }, input.homeDir, [input.cwd]), undefined),
    inspect('skill sources', () => projectRoots(input.cwd), []),
    inspect('agent profile sources', () => projectAgentRoots(input.fs, input.cwd, (message) => warnings.push(message)), []),
  ]);
  const instructionSources = {
    agentsMdPaths: instructions?.paths ?? [],
    skills: skills.map((root) => root.path),
    agentProfiles: profiles.map((root) => root.path),
  };
  if (instructions?.warning !== undefined) warnings.push(instructions.warning);
  return {
    gatedMcpServers,
    additionalDirs: dirs?.additionalDirs ?? [],
    additionalDirSources: dirs !== undefined && dirs.additionalDirs.length > 0 ? [dirs.configPath] : [],
    instructionSources,
    warnings: warnings.toSorted(),
  };
}
