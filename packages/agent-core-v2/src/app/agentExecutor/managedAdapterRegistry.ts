import { join } from 'pathe';

import type { AgentExecutorDescriptor } from './agentExecutor';

export interface ManagedAdapterRelease {
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly source: string;
  readonly entry: string;
}

export const MANAGED_ADAPTER_RELEASES: Readonly<Record<string, ManagedAdapterRelease>> = {
  'claude-acp': {
    packageName: '@agentclientprotocol/claude-agent-acp',
    version: '0.84.0',
    integrity: 'sha512-Zhjyxvm7USDB/BAFx2L6U6rA3spJ6qwEDFbLgByzpmQMeZGuAlZPXhMcAc+Xsndj9kDh+OFJNjETRwGJCR1eTQ==',
    source: 'https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-0.84.0.tgz',
    entry: 'dist/index.js',
  },
  'codex-acp': {
    packageName: '@agentclientprotocol/codex-acp',
    version: '2.0.0',
    integrity: 'sha512-dho7RRXP+7Ur813qKgPVoAKjr4x3A8IcOoBOTYJRkcCNgcGraP5x3/5lPcZ0QgcVm0ErdYXRPYjwdSzvZHaKqw==',
    source: 'https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-2.0.0.tgz',
    entry: 'dist/index.js',
  },
};

export const MANAGED_ADAPTER_SCOPE = 'managed-executors';

export interface ManagedAdapterInstallation {
  readonly version: string;
  readonly integrity: string;
  readonly source: string;
  readonly installId: string;
}

export interface ManagedAdapterState {
  readonly active: ManagedAdapterInstallation;
  readonly previous?: ManagedAdapterInstallation;
}

export function managedAdapterEntry(
  id: string,
  homeDir: string,
  installation: ManagedAdapterInstallation | undefined,
): string | undefined {
  const release = Object.hasOwn(MANAGED_ADAPTER_RELEASES, id) ? MANAGED_ADAPTER_RELEASES[id] : undefined;
  if (release === undefined || installation === undefined) return undefined;
  if (!/^[a-f0-9-]{36}$/.test(installation.installId) ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(installation.version)) return undefined;
  return join(homeDir, 'tools', 'managed-executors', id,
    `${installation.version}-${installation.installId}`, 'node_modules', release.packageName, release.entry);
}

export function withManagedAdapterSource(
  descriptor: AgentExecutorDescriptor,
  homeDir: string,
  state: ManagedAdapterState | undefined,
): AgentExecutorDescriptor {
  const entry = managedAdapterEntry(descriptor.id, homeDir, state?.active);
  if (entry === undefined) return descriptor;
  if (descriptor.sources === undefined) {
    if (descriptor.command === undefined) return descriptor;
    return { ...descriptor, sources: [
      { id: 'kiki-managed', kind: 'node-script', path: entry },
      { id: 'path', kind: 'path-lookup', command: descriptor.command },
    ] };
  }
  if (!descriptor.sources.some((source) => source.id === 'kiki-managed')) return descriptor;
  return {
    ...descriptor,
    sources: descriptor.sources.map((source) => source.id === 'kiki-managed'
      ? { id: source.id, kind: 'node-script' as const, path: entry } : source),
  };
}
