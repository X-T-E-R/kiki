import { relative, isAbsolute, dirname } from 'node:path';
import type { BoundEndpoint } from '@kiki/protocol';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { autoModelApprovalContext } from '#/session/subagent/autoModelApproval';
import type { DispatchSelectorCall } from '#/session/dispatch/dispatch';
import type { IAdhocEndpointVault } from './adhocEndpointVault';
import type { RuntimePath, RuntimeWorkspaceRoots } from '#/runtime/runtime';
import type { IWorkspaceService } from '#/app/workspace/workspace';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { readWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';
import { Error2, ErrorCodes } from '#/errors';

export async function assertEndpointSourceTrusted(profile: AgentProfile, cwd: string, docs: IAtomicDocumentStore, workspaces?: IWorkspaceService, runtimeSource?: { readonly path: RuntimePath; readonly realpath: (path: string) => Promise<string>; readonly roots: RuntimeWorkspaceRoots }): Promise<void> {
  const source = profile.fileDefinition?.source;
  const path = profile.sourcePath ?? profile.fileDefinition?.path;
  const rel = path === undefined ? undefined : relative(cwd, path);
  let within = rel !== undefined && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../');
  if ((source === 'explicit' || source === 'extra') && path !== undefined && runtimeSource !== undefined) {
    const { path: runtimePath, realpath, roots } = runtimeSource;
    const realFile = await realpath(path);
    within = false;
    for (const root of [roots.workDir, ...(roots.additionalDirs ?? [])]) {
      const realRoot = await realpath(root);
      const relativeFile = runtimePath.relative(realRoot, realFile);
      if (!runtimePath.isAbsolute(relativeFile) && relativeFile !== '..' && !relativeFile.startsWith(`..${runtimePath.separator}`)) within = true;
    }
  }
  let root = source === 'project' || source === 'plugin' || ((source === 'explicit' || source === 'extra') && within) ? cwd : undefined;
  if (!within && (source === 'explicit' || source === 'extra') && path !== undefined && workspaces !== undefined) {
    let directory = dirname(path);
    for (;;) {
      const registered = await workspaces.findRegisteredByRoot(directory);
      if (registered !== undefined) { root = registered.root; break; }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (root === undefined) return;
  if (!await readWorkspaceTrust(docs, root)) throw new Error2(ErrorCodes.REQUEST_INVALID, 'Endpoint declarations in untrusted workspace or plugin profiles cannot be used. Trust the workspace before dispatch.');
}

export async function authorizeEndpoint(endpoint: BoundEndpoint, vault: IAdhocEndpointVault, owner: Pick<IAgentScopeHandle, 'accessor'>,
  workDir: string, signal: AbortSignal, call?: DispatchSelectorCall): Promise<void> {
  if (owner.accessor.get(IAgentPermissionModeService).mode === 'yolo' || vault.approved(endpoint)) return;
  const credential = endpoint.credential.kind === 'env' ? `env: ${endpoint.credential.env}` : 'ephemeral api_key';
  const context = autoModelApprovalContext({ base_url: endpoint.base_url, provider_type: endpoint.provider_type, model: endpoint.model, credential }, workDir, signal, call);
  const summary = `Allow evaluation endpoint ${endpoint.base_url} (${endpoint.model}; ${credential})`;
  const result = await owner.accessor.get(IAgentToolApprovalService).requestToolApproval({ ...context,
    execution: { ...context.execution, description: summary, display: { kind: 'generic', summary, detail: context.args } },
  }, { kind: 'ask' }, 'adhoc-endpoint');
  if (result?.veto !== undefined || result?.permissionDecision === 'rejected' || result?.permissionDecision === 'cancelled') throw new Error2(ErrorCodes.REQUEST_INVALID, 'The evaluation endpoint was not approved.');
  signal.throwIfAborted();
  vault.approve(endpoint);
}
