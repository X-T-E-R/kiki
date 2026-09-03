import {
  isDirectoryPath as isDirectory,
  isFilePath as isFile,
  pathExists as exists,
  resolveAgentPath,
} from '@kiki/agent-profiles/paths';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { agentProfilesHostFs } from './hostFs';

export { resolveAgentPath };

export function isDirectoryPath(fs: IHostFileSystem, path: string): Promise<boolean> {
  return isDirectory(agentProfilesHostFs(fs), path);
}

export function isFilePath(fs: IHostFileSystem, path: string): Promise<boolean> {
  return isFile(agentProfilesHostFs(fs), path);
}

export function pathExists(fs: IHostFileSystem, path: string): Promise<boolean> {
  return exists(agentProfilesHostFs(fs), path);
}
