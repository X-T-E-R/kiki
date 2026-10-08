import { ILogService } from '#/_base/log/log';
import { dirname } from 'pathe';

import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import { profilesFromDiscovery } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileFromFile';
import { agentProfileDefinitionId, resolveAgentSourceGraph } from '#/workspace/workspaceAgentProfileLoader/internal/agentSourceGraph';
import type { AgentFileDefinition } from '#/workspace/workspaceAgentProfileLoader/internal/types';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { resolveAgentPath } from '#/workspace/workspaceAgentProfileLoader/internal/paths';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IAgentExecutorRegistry } from '#/app/agentExecutor/agentExecutor';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { Error2, ErrorCodes } from '#/errors';
import type { FrozenProfileFileSources } from '#/session/dispatch/profileFile';
import { projectAgentProfileCatalog } from '@kiki/agent-profiles/profileCatalog';

import { IExplicitAgentProfileLoader } from './explicitAgentProfileLoader';

export class ExplicitAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExplicitAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'explicit';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.explicit;
  protected override readonly fatal = true;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IAgentExecutorRegistry private readonly executors: IAgentExecutorRegistry,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    return loadExplicitAgentProfileContribution({
      files: this.bootstrap.args.agentFiles ?? [],
      cwd: this.workspace.cwd,
      osHomeDir: this.bootstrap.osHomeDir,
      fs: this.fs,
      log: this.log,
      user: this.user,
      executors: this.executors,
    });
  }
}

export async function loadExplicitAgentProfileContribution(input: {
  readonly files: readonly string[];
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly fs: IHostFileSystem;
  readonly log: ILogService;
  readonly user: IUserAgentProfileLoader;
  readonly executors: IAgentExecutorRegistry;
}): Promise<AgentProfileContribution> {
  const definitions: AgentFileDefinition[] = [];
  for (const file of input.files) {
    definitions.push(await readExplicitAgentProfileFile({ ...input, file, warn: (message) => input.log.warn(message) }));
  }
  const graph = await resolveAgentSourceGraph(input.fs, definitions, (message, error) => {
    input.log.warn(message, error);
  });
  return profilesFromDiscovery(
    {
      agents: definitions,
      routes: [],
      skipped: [],
      scannedRoots: definitions.map((definition) => definition.contributionRoot),
      ...graph,
    },
    (context) => input.user.getDefaultProfile().renderSystemPrompt(context),
    (context) => input.user.getBuiltinDefault().renderSystemPrompt(context),
    { registry: input.executors, allowExternal: true },
  );
}

interface ExplicitAgentProfileFileInput {
  readonly file: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly fs: IHostFileSystem;
  readonly warn?: (message: string, error?: unknown) => void;
}

async function readExplicitAgentProfileFile(input: ExplicitAgentProfileFileInput): Promise<AgentFileDefinition> {
  const lexicalPath = resolveAgentPath(input.file, input.cwd, input.osHomeDir);
  const filePath = (await input.fs.realpath(lexicalPath)).replaceAll('\\', '/');
  return parseAgentFileText({
    path: filePath, source: 'explicit', text: await input.fs.readText(filePath),
    definitionId: agentProfileDefinitionId(filePath),
    contributionRoot: (await input.fs.realpath(dirname(filePath))).replaceAll('\\', '/'),
    warn: input.warn,
  });
}

export async function loadMainAgentProfileFile(input: ExplicitAgentProfileFileInput & {
  readonly defaultProfile: AgentProfile;
  readonly builtinProfile: AgentProfile;
  readonly executors: IAgentExecutorRegistry;
  readonly resolveBase: (name: string) => AgentProfile | undefined;
  readonly baseEntries: readonly import('@kiki/agent-profiles/profileCatalog').AgentProfileRegistration[];
}): Promise<AgentProfile & { readonly fileSources: FrozenProfileFileSources }> {
  try {
    if (!/\.md$/i.test(input.file.trim())) throw new Error('Choose a profile Markdown (.md) file');
    const definition = await readExplicitAgentProfileFile(input);
    const graph = await resolveAgentSourceGraph(input.fs, [definition], input.warn);
    const contribution = profilesFromDiscovery({
      agents: [definition], routes: [], skipped: [], scannedRoots: [definition.contributionRoot], ...graph,
    }, (context) => input.defaultProfile.renderSystemPrompt(context),
    (context) => input.builtinProfile.renderSystemPrompt(context),
    { registry: input.executors, allowExternal: true });
    const declared = contribution.profiles[0];
    if (declared === undefined) throw new Error(contribution.skipped?.[0]?.reason ?? 'The profile file could not be loaded');
    let profile = declared;
    if (declared.systemPromptMode === 'inherit') {
      const pathKey = (path: string | undefined) => path === undefined ? undefined
        : /^(?:[a-zA-Z]:|\/\/)/.test(path) ? path.toLowerCase() : path;
      const entries = input.baseEntries.map((entry) => ({ ...entry, contribution: {
        ...entry.contribution, profiles: entry.contribution.profiles.filter((candidate) =>
          candidate.name === declared.name && pathKey(candidate.sourcePath) !== pathKey(declared.sourcePath)),
      } }));
      if (!entries.some((entry) => entry.contribution.profiles.length > 0)) {
        const base = input.resolveBase(declared.name);
        if (base !== undefined && pathKey(base.sourcePath) !== pathKey(declared.sourcePath)) {
          entries.push({ sourceId: 'effective-base', priority: 0, contribution: { profiles: [{ ...base, systemPromptMode: undefined }] } });
        }
      }
      const projected = projectAgentProfileCatalog({
        entries: [...entries, { sourceId: 'explicit-file', priority: Math.max(AGENT_PROFILE_SOURCE_PRIORITY.explicit, ...entries.map((entry) => entry.priority)) + 1, contribution }],
        disabledNamedProfiles: new Set(), routeBaseMissingCode: ErrorCodes.ROUTE_BASE_MISSING,
        warn: (message) => input.warn?.(message),
      });
      const resolved = projected.resolvableProfiles.get(declared.name);
      if (resolved === undefined || resolved.sourcePath !== declared.sourcePath) throw new Error(`Profile "${declared.name}" requires a lower-priority profile for system_prompt_mode "inherit"`);
      profile = resolved;
    }
    const fileSources: FrozenProfileFileSources = {
      root: definition,
      scopedBindings: Object.fromEntries([...graph.scopedBindings].map(([id, bindings]) => [id, Object.fromEntries(bindings)])),
      sourceDefinitions: Object.fromEntries(graph.sourceDefinitions),
      dependencyIndex: Object.fromEntries(graph.dependencyIndex), diagnostics: graph.diagnostics,
    };
    return { ...profile, fileSources };
  } catch (error) {
    throw new Error2(ErrorCodes.REQUEST_INVALID,
      `Unable to load profile file "${input.file}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { path: input.file } });
  }
}
