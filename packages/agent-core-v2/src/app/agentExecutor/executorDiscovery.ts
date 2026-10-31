import { dirname, join } from 'pathe';
import type { ExecutorDiscoveryStatus } from '@kiki/protocol';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { AgentExecutorDescriptor } from './agentExecutor';
import { discoverExecutorMetadata, locateCommand } from './binaryDiscovery';
import { sourceOwnedAdapterScript } from './managedAdapterRegistry';

export async function readExecutorDiscovery(
  descriptor: AgentExecutorDescriptor,
  fs: IHostFileSystem,
  bootstrap: IBootstrapService,
): Promise<ExecutorDiscoveryStatus> {
  const identity = { id: descriptor.id, label: descriptor.label ?? descriptor.id, protocol: descriptor.protocol };
  try {
    const probes = await discoverExecutorMetadata(descriptor, fs, bootstrap);
    const selected = probes.find(probe => probe.available);
    const path = selected?.launchArgs?.[0] ?? selected?.command;
    const version = path === undefined || selected?.kind !== 'node-script' ? undefined : await packageVersion(path, fs);
    const failed = selected === undefined ? probes.find(probe => probe.diagnosticCode === 'metadata_unreadable')
      ?? probes.find(probe => probe.diagnostic !== undefined) : undefined;
    const reason = selected === undefined ? failed?.diagnostic ?? 'No executable source was found' : undefined;
    const reasonCode = selected === undefined ? failed?.diagnosticCode ?? 'path_not_found' : undefined;
    const components: ExecutorDiscoveryStatus['components'] = [{
      id: descriptor.id, label: descriptor.programLabel ?? identity.label, role: 'program',
      installed: selected !== undefined, path, version, reason, reason_code: reasonCode,
    }];
    const dependencies = new Map((descriptor.diagnostics ?? []).flatMap(rule => rule.kind === 'dependency'
      ? [[rule.command, rule.label ?? rule.command] as const] : []));
    const agy = sourceOwnedAdapterScript(descriptor) !== undefined;
    if (agy) dependencies.set(descriptor.env?.['AGY_CLI_PATH']?.trim() || 'agy', 'AGY CLI');
    for (const [command, label] of dependencies) {
      try {
        const dependency = await locateCommand(command, fs, bootstrap, true);
        components.push({ id: command, label, role: 'dependency', installed: dependency !== undefined,
          path: dependency, reason: dependency === undefined ? `${label} was not found` : undefined,
          reason_code: dependency !== undefined ? undefined : /[\\/]/.test(command) ? 'path_not_found' : 'not_on_path' });
      } catch {
        components.push({ id: command, label, role: 'dependency', installed: false,
          reason: `${label} metadata could not be read`, reason_code: 'metadata_unreadable' });
      }
    }
    const missingAgy = agy ? components.find(component => component.role === 'dependency' && !component.installed) : undefined;
    const installed = selected !== undefined && missingAgy === undefined;
    const failureCode = reasonCode ?? missingAgy?.reason_code;
    return { ...identity, installed, status: installed ? 'installed' : failureCode === 'metadata_unreadable' ? 'error' : 'missing',
      checked_at: new Date().toISOString(), path, version, source: selected?.id, source_kind: selected?.kind,
      reason: reason ?? missingAgy?.reason, reason_code: failureCode, components };
  } catch {
    return { ...identity, installed: false, status: 'error', checked_at: new Date().toISOString(),
      reason: 'Installed engine metadata could not be read', reason_code: 'metadata_unreadable', components: [] };
  }
}

async function packageVersion(path: string, fs: IHostFileSystem): Promise<string | undefined> {
  let root = dirname(path);
  for (let depth = 0; depth < 3; depth++) {
    try {
      const file = join(root, 'package.json');
      const stat = await fs.stat(file);
      if (stat.isFile && stat.size <= 65_536) {
        const data: unknown = JSON.parse(await fs.readText(file));
        if (data !== null && typeof data === 'object' && 'version' in data
          && typeof data.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(data.version)) return data.version;
      }
    } catch {}
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return undefined;
}
