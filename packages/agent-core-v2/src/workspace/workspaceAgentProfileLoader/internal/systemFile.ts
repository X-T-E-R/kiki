import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  loadSystemMdProfile as loadProfile,
  SYSTEM_MD_FILENAME,
} from '@kiki/agent-profiles/systemFile';

import { agentProfilesHostFs } from './hostFs';

export { SYSTEM_MD_FILENAME };

export function loadSystemMdProfile(
  fs: IHostFileSystem,
  brandHome: string,
  builtinDefault: AgentProfile,
  warn: (message: string) => void,
): Promise<AgentProfile | undefined> {
  return loadProfile(agentProfilesHostFs(fs), brandHome, builtinDefault, warn) as Promise<AgentProfile | undefined>;
}
