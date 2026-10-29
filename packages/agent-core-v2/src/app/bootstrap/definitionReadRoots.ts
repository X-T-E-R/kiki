import { join } from 'pathe';
import type { IBootstrapService } from './bootstrap';
import { resolveSpaceInheritance } from './spaceInheritance';

export function kikiDefinitionReadRoots(bootstrap: Pick<IBootstrapService, 'homeDir' | 'userAgentProfileHomeDir' | 'space' | 'baseHomeDir'> | undefined): readonly string[] {
  if (bootstrap === undefined) return [];
  const inheritance = resolveSpaceInheritance(bootstrap);
  return [...new Set([
    ...['agents', 'skills', 'commands', 'docs'].map((name) => join(bootstrap.homeDir, name)),
    join(bootstrap.userAgentProfileHomeDir ?? bootstrap.homeDir, 'agents'),
    ...inheritance.agents && inheritance.baseHomeDir !== undefined ? [join(inheritance.baseHomeDir, 'agents')] : [],
  ])];
}
