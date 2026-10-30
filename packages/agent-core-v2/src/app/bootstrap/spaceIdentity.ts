import { join } from 'pathe';
import type { KikiSpaceContext } from '@kiki/agent-profiles/agentProfile';
import type { IBootstrapService } from './bootstrap';

export function projectSpaceIdentity(bootstrap: Pick<IBootstrapService, 'homeDir' | 'space' | 'baseHomeDir' | 'homeDiagnostic'>): KikiSpaceContext {
  const { homeDir, space, baseHomeDir, homeDiagnostic } = bootstrap;
  if (homeDiagnostic !== undefined) return { id: 'unavailable', name: 'Unavailable space', kind: 'unavailable', homeDir };
  return space === undefined
    ? { id: 'main', name: 'Main space', kind: 'main', homeDir }
    : { id: space.id, name: space.name, kind: 'space', homeDir, baseHomeDir };
}

export function renderSpaceContext(space: KikiSpaceContext | undefined): string {
  if (space === undefined) return '## Space\n(unavailable)';
  return [
    '## Space',
    `Name: ${JSON.stringify(space.name)}`,
    `ID: ${JSON.stringify(space.id)}`,
    `Kind: ${space.kind === 'space' ? 'space (non-main)' : space.kind}`,
    `Kiki home (server host): ${JSON.stringify(space.homeDir)}`,
    `Base home (inherited resources): ${space.baseHomeDir === undefined ? '(none)' : JSON.stringify(space.baseHomeDir)}`,
    `Product docs (server host): ${JSON.stringify(join(space.homeDir, 'docs'))}`,
    space.kind === 'unavailable'
      ? 'Space metadata is invalid. Repair home.toml in this Kiki home and restart; do not assume this is the main space.'
      : 'Use this Kiki home for config, sessions, memory, logs, and local Kiki CLI operations. The base supplies selected inherited resources; it is not the current write home. Do not substitute the OS user\'s ~/.kiki. Server-host paths do not identify remote SSH paths. If these docs are unavailable, report that instead of silently reading base or main docs.',
  ].join('\n');
}
