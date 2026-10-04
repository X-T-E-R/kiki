import {
  resolveRealPathAccess,
  resolveRealPathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '#/app/edit/fileEdit';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime } from '#/runtime/runtime';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { acquireToolRuntime, prepareToolRuntime, resolveSshToolTarget, tagSshResult, toolApprovalRule, toolParametersWithHost } from '#/agent/tools/os/sshToolTarget';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { EditInputSchema, IEditTool, type EditInput } from './edit';
import editDescriptionTemplate from './edit.md?raw';

export class EditTool implements IEditTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Edit' as const;
  readonly description = editDescriptionTemplate;
  get parameters(): Record<string, unknown> {
    return toolParametersWithHost(toInputJsonSchema(EditInputSchema), this.runtime.nativeSshEnabled?.() === true);
  }

  constructor(
    @IFileEditService private readonly editor: IFileEditService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  private workspaceConfig(runtime: Runtime): WorkspaceConfig {
    const view = new RuntimeWorkspaceView(runtime, {
      workDir: this.workspaceCtx.workDir,
      additionalDirs: this.workspaceCtx.additionalDirs,
    });
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: EditInput): Promise<ToolExecution> {
    const target = resolveSshToolTarget(args.host, args.path);
    args = { ...args, path: target.path ?? args.path };
    const inspected = await prepareToolRuntime(this.runtime, target.host);
    const generation = inspected.identity.generation;
    const env = inspected.environment;
    const workspace = this.workspaceConfig(inspected);
    const pathOptions = { env, workspace, operation: 'write' as const };
    const preparation = acquireToolRuntime(this.runtime, target.host, ['fs']);
    let path: string;
    let external = false;
    try {
      if (preparation.runtime.identity.generation !== generation) {
        return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
      }
      const admitted = await resolveRealPathAccess(args.path, pathOptions, preparation.runtime.fs!);
      path = admitted.path;
      external = admitted.implicitExternal === true ||
        (inspected.identity.runtimeId.startsWith('ssh:') && admitted.outsideWorkspace);
    } finally {
      preparation.dispose();
    }
    return {
      accesses: external ? ToolAccesses.file('readwrite', path, { implicitExternal: true }) : ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: toolApprovalRule(this.name, path, inspected, target.host),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async () => {
        const lease = target.host === undefined
          ? this.runtime.acquire(['fs']) : acquireToolRuntime(this.runtime, target.host, ['fs']);
        try {
          if (lease.runtime.identity.generation !== generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          try {
            const currentPath = await resolveRealPathAccessPath(args.path, pathOptions, lease.runtime.fs!);
            if ((env.pathClass === 'win32' ? currentPath.toLowerCase() : currentPath) !==
              (env.pathClass === 'win32' ? path.toLowerCase() : path)) {
              return { isError: true, output: `File target changed after path admission: admitted "${path}", actual "${currentPath}". Use the actual absolute path or resolve a changed link first.` };
            }
          } catch (error) {
            return { isError: true, output: error instanceof Error ? error.message : String(error) };
          }
          return tagSshResult(await this.execution(args, path, lease.runtime.fs!), inspected);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    args: EditInput,
    safePath: string,
    fs: IHostFileSystem,
  ): Promise<ExecutableToolResult> {
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    const result = await this.editor.edit({
      path: safePath,
      displayPath: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all ?? false,
    }, fs);
    if (!result.ok) {
      return { isError: true, output: result.error };
    }
    const word = result.count === 1 ? 'occurrence' : 'occurrences';
    return { output: `Replaced ${String(result.count)} ${word} in ${args.path}` };
  }
}

registerAgentToolService(IEditTool, EditTool, {
  name: 'Edit',
  domain: 'edit',
  requiredRuntimeCapabilities: ['fs'],
});
