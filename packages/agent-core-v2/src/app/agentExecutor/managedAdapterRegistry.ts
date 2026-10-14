import { basename, join, normalize } from 'pathe';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';

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

export const SOURCE_OWNED_ADAPTER_FILES = Object.freeze([
  'agy-cli-acp.mjs',
  'agy-hook-registration.mjs',
  'agy-permission-hook.mjs',
]);

export const SOURCE_OWNED_ADAPTER_ENTRY = 'agy-cli-acp.mjs';

export const SOURCE_OWNED_ADAPTER_VERSION = '0.4.1';

export const SOURCE_OWNED_ADAPTER_SUPPORTS_MCP = true;

export const SOURCE_OWNED_ADAPTER_ROOT_ENV = 'KIKI_SOURCE_OWNED_ADAPTER_ROOT';

export const SOURCE_OWNED_ADAPTER_SOURCE = 'bundled:external-harness';

export const SOURCE_OWNED_ADAPTER_PACKAGE = 'kiki-external-harness';

export interface ManagedAdapterInstallation {
  readonly version: string;
  readonly integrity: string;
  readonly source: string;
  readonly installId: string;
  readonly targetDir?: string;
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

export function sourceOwnedAdapterScript(descriptor: AgentExecutorDescriptor): string | undefined {
  const sources = descriptor.sources;
  if (sources === undefined || sources.length === 0) return undefined;
  const selected = descriptor.source === undefined
    ? (sources.length === 1 ? sources : [])
    : sources.filter((source) => source.id === descriptor.source);
  const source = selected.length === 1 ? selected[0] : undefined;
  if (source === undefined || source.kind !== 'node-script') return undefined;
  if (basename(source.path) !== SOURCE_OWNED_ADAPTER_ENTRY) return undefined;
  return source.path;
}

export function expandSourceOwnedAdapterPath(
  value: string,
  bootstrap: Pick<IBootstrapService, 'homeDir' | 'osHomeDir'>,
): string {
  const homeExpanded = value.replace(/^~(?=$|[\\/])/, bootstrap.osHomeDir);
  return normalize(homeExpanded.replaceAll('${KIKI_HOME}', bootstrap.homeDir));
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
