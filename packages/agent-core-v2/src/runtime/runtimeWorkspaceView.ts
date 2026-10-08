import { ErrorCodes, Error2 } from '#/errors';
import { createShellPathBridge, getShellPathBridge, type ShellPathBridge } from '#/_base/execEnv/shellPathBridge';

import type { Runtime, RuntimeBinding, RuntimeWorkspaceRoots } from './runtime';

export type { RuntimeWorkspaceRoots } from './runtime';

export class RuntimeWorkspaceView {
  readonly binding: RuntimeBinding;
  readonly generation: string;
  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly roots: readonly string[];

  constructor(
    readonly runtime: Runtime,
    roots: RuntimeWorkspaceRoots,
  ) {
    this.binding = {
      workspaceId: runtime.identity.workspaceId,
      runtimeId: runtime.identity.runtimeId,
    };
    this.generation = runtime.identity.generation;
    const mapped = runtime.workspace.mapRoots(roots);
    this.workDir = runtime.path.resolve(mapped.workDir);
    this.additionalDirs = [...new Set((mapped.additionalDirs ?? []).map((root) => runtime.path.resolve(root)))];
    this.roots = [this.workDir, ...this.additionalDirs];
  }

  resolve(path: string, cwd = this.workDir, allowExternalAbsolutePath = false): string {
    const bridged = runtimeShellPathBridge(this.runtime).fromShellPath(path);
    const absolute = this.runtime.path.isAbsolute(bridged);
    const resolved = absolute
      ? this.runtime.path.resolve(bridged)
      : this.runtime.path.resolve(cwd, bridged);
    if (!(allowExternalAbsolutePath && absolute && this.runtime.workspace.supportsExternalPaths === true)) {
      this.assertAllowed(resolved, path);
    }
    return resolved;
  }

  assertAllowed(path: string, rawPath = path): void {
    const resolved = this.runtime.path.resolve(path);
    if (this.roots.some((root) => contains(this.runtime, root, resolved))) return;
    throw new Error2(
      ErrorCodes.FS_PATH_ESCAPES,
      `[external_target_approval] Path "${rawPath}" resolves to external target "${resolved}" outside runtime workspace ${this.binding.runtimeId}. Use an explicit absolute path in an agent file tool and obtain approval, or choose a workspace path for this operation.`,
      { details: { path: resolved, rawPath, target: resolved, reason: 'external_target_approval' } },
    );
  }
}

function contains(runtime: Runtime, root: string, candidate: string): boolean {
  const relative = runtime.path.relative(root, candidate);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${runtime.path.separator}`) && !runtime.path.isAbsolute(relative);
}

export function runtimeShellPathBridge(runtime: Runtime): ShellPathBridge {
  if (!runtime.identity.runtimeId.startsWith('ssh:')) return getShellPathBridge(runtime.environment);
  return createShellPathBridge(runtime.environment, {
    isFile: () => false,
    execFileSync: () => { throw new Error('Remote shell paths cannot be resolved using local executables'); },
  });
}
