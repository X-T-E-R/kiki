import {
  resolveRealPathAccess,
  resolveRealPathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '#/app/edit/fileEdit';
import { linesLabel, type EditOperation } from '#/app/edit/editService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { Runtime } from '#/runtime/runtime';
import { RuntimeWorkspaceView, runtimeShellPathBridge } from '#/runtime/runtimeWorkspaceView';
import { acquireToolRuntime, prepareToolRuntime, resolveSshToolTarget, tagSshResult, toolApprovalRule, hostToolParameters } from '#/agent/tools/os/sshToolTarget';
import { IAgentRuntimeService, inspectAgentWorkspaceRoots } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { EditInputSchema, IEditTool, type EditInput } from './edit';
import editDescriptionTemplate from './edit.md?raw';

const DISPLAY_EDIT_SEPARATOR = '\n…\n';

interface EditPlan {
  readonly edits: readonly EditOperation[];
  readonly indexed: boolean;
}

function editPlan(args: EditInput): EditPlan | string {
  const singleForm = args.old_string !== undefined || args.new_string !== undefined || args.replace_all === true;
  if (args.edits !== undefined) {
    if (singleForm) {
      return 'Give either old_string and new_string (with optional replace_all) or edits, not both.';
    }
    const unchanged = args.edits.findIndex((edit) => edit.old_string === edit.new_string);
    if (unchanged !== -1) {
      return `edits[${String(unchanged)}] makes no change: its old_string and new_string are exactly the same.`;
    }
    return {
      indexed: true,
      edits: args.edits.map((edit) => ({
        old_string: edit.old_string,
        new_string: edit.new_string,
        replace_all: edit.replace_all ?? false,
      })),
    };
  }
  if (args.old_string === undefined || args.new_string === undefined) {
    return 'Edit needs old_string and new_string, or an edits list with at least one replacement.';
  }
  if (args.old_string === args.new_string) {
    return 'No changes to make: old_string and new_string are exactly the same.';
  }
  return {
    indexed: false,
    edits: [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all ?? false }],
  };
}

function indexedFailure(index: number, path: string, error: string): string {
  const earlier = index === 0
    ? ''
    : ` Line numbers in this message count lines after ${index === 1 ? 'edits[0] was' : `edits[0]–edits[${String(index - 1)}] were`} applied in memory.`;
  return `edits[${String(index)}] failed, so ${path} was not changed. ${error}${earlier}`;
}

export class EditTool implements IEditTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Edit' as const;
  readonly description = editDescriptionTemplate;
  get parameters(): Record<string, unknown> {
    return hostToolParameters(EditInputSchema, this.runtime.nativeSshEnabled?.() === true);
  }

  constructor(
    @IFileEditService private readonly editor: IFileEditService,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
  ) {}

  private workspaceConfig(runtime: Runtime): WorkspaceConfig {
    const view = new RuntimeWorkspaceView(runtime, inspectAgentWorkspaceRoots(this.runtime, this.workspaceCtx));
    return { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
  }

  async resolveExecution(args: EditInput): Promise<ToolExecution> {
    const plan = editPlan(args);
    if (typeof plan === 'string') return { isError: true, output: plan };
    const target = resolveSshToolTarget(args.host, args.path);
    args = { ...args, path: target.path ?? args.path };
    const inspected = await prepareToolRuntime(this.runtime, target.host);
    const generation = inspected.identity.generation;
    const env = inspected.environment;
    const workspace = this.workspaceConfig(inspected);
    const pathOptions = { env, workspace, operation: 'write' as const, shellPathBridge: runtimeShellPathBridge(inspected) };
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
        before: plan.edits.map((edit) => edit.old_string).join(DISPLAY_EDIT_SEPARATOR),
        after: plan.edits.map((edit) => edit.new_string).join(DISPLAY_EDIT_SEPARATOR),
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
          return tagSshResult(await this.execution(args.path, plan, path, lease.runtime.fs!), inspected);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    displayPath: string,
    plan: EditPlan,
    safePath: string,
    fs: IHostFileSystem,
  ): Promise<ExecutableToolResult> {
    const result = await this.editor.edit({ path: safePath, displayPath, edits: plan.edits }, fs);
    if (!result.ok) {
      return {
        isError: true,
        output: plan.indexed && result.editIndex !== undefined
          ? indexedFailure(result.editIndex, displayPath, result.error)
          : result.error,
      };
    }
    const where = result.changedLines.length === 0 ? '' : ` (${linesLabel(result.changedLines)})`;
    const word = result.replacements === 1 ? 'occurrence' : 'occurrences';
    if (!plan.indexed) {
      return { output: `Replaced ${String(result.replacements)} ${word} in ${displayPath}${where}.` };
    }
    const editWord = plan.edits.length === 1 ? 'edit' : 'edits';
    return {
      output: `Applied ${String(plan.edits.length)} ${editWord} to ${displayPath}, replacing ${String(result.replacements)} ${word}${where}.`,
    };
  }
}

registerAgentToolService(IEditTool, EditTool, {
  name: 'Edit',
  domain: 'edit',
  requiredRuntimeCapabilities: ['fs'],
});
