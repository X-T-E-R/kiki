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
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';

export async function assertEndpointSourceTrusted(profile: AgentProfile, cwd: string, docs: IAtomicDocumentStore,
  workspaces: IWorkspaceService | undefined,
  context: { readonly path: RuntimePath; readonly realpath: (path: string) => Promise<string>; readonly roots: RuntimeWorkspaceRoots; readonly operatorRoots: readonly string[] }): Promise<void> {
  const source = profile.fileDefinition?.source;
  if (source === 'user' || (source === undefined && profile.fileDefinition === undefined)) return;
  const reject = (): never => { throw new Error2(ErrorCodes.REQUEST_INVALID, 'Endpoint declarations in untrusted workspace or plugin profiles cannot be used. Trust the owning workspace before dispatch.'); };
  if (source === 'plugin') reject();
  const { path, realpath, roots } = context;
  const contains = (root: string, file: string): boolean => {
    const relative = path.relative(root, file);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.separator}`);
  };
  const file = profile.sourcePath ?? profile.fileDefinition?.path;
  if (file === undefined) {
    if (source === 'project' && await readWorkspaceTrust(docs, cwd)) return;
    return reject();
  }
  const realFile = await realpath(file);
  if (source === 'explicit' || source === 'extra' || source === 'inherited') {
    for (const root of context.operatorRoots) {
      let realRoot: string;
      try { realRoot = await realpath(root); }
      catch (error) {
        if (isError2(error) && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) continue;
        throw error;
      }
      if (contains(realRoot, realFile)) return;
    }
  }
  let owner: { readonly realRoot: string; readonly trustRoot: string } | undefined;
  for (const root of [roots.workDir, ...(roots.additionalDirs ?? [])]) {
    const realRoot = await realpath(root);
    if (contains(realRoot, realFile) && (owner === undefined || contains(owner.realRoot, realRoot))) owner = { realRoot, trustRoot: root };
  }
  if (workspaces !== undefined) {
    let directory = path.dirname(realFile);
    for (;;) {
      const registered = await workspaces.findRegisteredByRoot(directory);
      if (registered !== undefined) {
        if (owner === undefined || contains(owner.realRoot, directory)) owner = { realRoot: directory, trustRoot: registered.root };
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  if (owner !== undefined && await readWorkspaceTrust(docs, owner.trustRoot)) return;
  reject();
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
