import path from 'node:path';

import {
  IBootstrapService,
  IConfigService,
  IWorkspaceService,
  type Scope,
} from '@kiki/agent-core-v2';
import { TaskBoardConfigSchema } from '@kiki/agent-core-v2/app/taskBoard/configSection';
import {
  createOwnWorkBoardService,
  type OwnWorkTaskApi,
} from '@kiki/agent-core-v2/app/taskBoard/ownWorkAdapter';
import type { ITaskBoardService } from '@kiki/agent-core-v2/app/taskBoard/taskBoard';
import * as ownWork from 'own-work/tasks';

function denied(): never {
  throw Object.assign(new Error('This storage location is not authorized for the workspace.'), {
    code: 'BOARD_ACCESS_DENIED',
  });
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function createPrintTaskBoardService(
  getApp: () => Scope,
  api: OwnWorkTaskApi = ownWork,
): ITaskBoardService {
  const storageConfig = () => TaskBoardConfigSchema.parse(
    getApp().accessor.get(IConfigService).get('taskBoard') ?? {},
  ).storage;

  return createOwnWorkBoardService(api, {
    currentWorkspaceId: () => undefined,
    storageConfig,
    async withWorkspace(workspaceId, _operation, use) {
      const app = getApp();
      const workspace = await app.accessor.get(IWorkspaceService).get(workspaceId);
      if (workspace === undefined) {
        throw Object.assign(new Error('Workspace is not registered.'), {
          code: 'WORKSPACE_NOT_FOUND',
        });
      }
      const host = app.accessor.get(IBootstrapService);
      const selected = storageConfig();
      const roots = selected.mode === 'auto'
        ? [workspace.root, path.join(host.sessionsDir, workspace.id, '.board')]
        : selected.mode === 'global'
          ? [path.join(host.homeDir, 'boards')]
          : [path.resolve(workspace.root, selected.path ?? '')];
      return use({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        homeDir: host.homeDir,
        sessionsDir: host.sessionsDir,
        async authorizeStorage(root) {
          if (!path.isAbsolute(root) || !roots.some((candidate) => samePath(root, candidate))) denied();
        },
      });
    },
  });
}
