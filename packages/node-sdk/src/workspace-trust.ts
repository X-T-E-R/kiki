import { homedir } from 'node:os';

import { HostFileSystem } from '@kiki/agent-core-v2/os/backends/node-local/hostFsService';
import { readProjectAdditionalDirs } from '@kiki/agent-core-v2/persistence/backends/node-fs/projectLocalConfigService';
import { describeWorkspaceTrustSources } from '@kiki/agent-core-v2/workspace/workspaceTrust/mcpDisclosure';

import type { WorkspaceTrustInfo } from '#/types';

/** Inspect workspace sources without starting an engine or connecting any server. */
export function inspectWorkspaceTrustSources(homeDir: string, workDir: string): Promise<Omit<WorkspaceTrustInfo, 'trusted'>> {
  const fs = new HostFileSystem();
  const osHomeDir = homedir();
  return describeWorkspaceTrustSources({
    fs, cwd: workDir, homeDir, osHomeDir,
    readAdditionalDirs: (cwd) => readProjectAdditionalDirs(fs, cwd, osHomeDir),
  });
}
