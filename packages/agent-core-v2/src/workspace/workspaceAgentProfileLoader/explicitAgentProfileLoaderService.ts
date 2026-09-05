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
    const lexicalPath = resolveAgentPath(file, input.cwd, input.osHomeDir);
    const filePath = (await input.fs.realpath(lexicalPath)).replaceAll('\\', '/');
    definitions.push(
      parseAgentFileText({
        path: filePath,
        source: 'explicit',
        text: await input.fs.readText(filePath),
        definitionId: agentProfileDefinitionId(filePath),
        contributionRoot: (await input.fs.realpath(dirname(filePath))).replaceAll('\\', '/'),
        warn: (message) => {
          input.log.warn(message);
        },
      }),
    );
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

