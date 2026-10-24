import type { CanonicalConfig } from '@nb-corp/nb-search';
import type { SettingsTransferNbSearchCredential } from '@kiki/protocol';
import { createDecorator } from '#/_base/di/instantiation';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { deepEqual } from '#/app/config/configPure';
import { LifecycleScope } from '#/app/scopes';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { NbSearchConfig } from './configSection';
import { managedBinding, managedEntryMatches, ManagedCredentialError, NbSearchManagedCredentials } from './managedCredentials';
import { INbSearchService } from './nbSearch';
import { INbSearchSourceStore, type NbSearchSource } from './sourceStore';

export interface NbSearchTransferCredentialState {
  readonly version: string;
  readonly bindingVersion: string;
  readonly binding: SettingsTransferNbSearchCredential['binding'];
  readonly value?: string;
  readonly active: boolean;
  readonly occupied: boolean;
}

export interface INbSearchTransferCredentials {
  readonly _serviceBrand: undefined;
  export(config: NbSearchConfig | undefined, reuseLocalConfig: boolean): Promise<readonly SettingsTransferNbSearchCredential[]>;
  inspect(config: NbSearchConfig | undefined, reuseLocalConfig: boolean, slotId: string): Promise<NbSearchTransferCredentialState>;
  write(resource: SettingsTransferNbSearchCredential, version: string, bindingVersion: string): Promise<void>;
}

export const INbSearchTransferCredentials = createDecorator<INbSearchTransferCredentials>('nbSearchTransferCredentials');

export class NbSearchTransferCredentials implements INbSearchTransferCredentials {
  declare readonly _serviceBrand: undefined;
  private readonly managed: NbSearchManagedCredentials;

  constructor(
    @IFileSystemStorageService storage: IFileSystemStorageService,
    @INbSearchSourceStore private readonly sources: INbSearchSourceStore,
    @INbSearchService private readonly service: INbSearchService,
    @IConfigService private readonly config: IConfigService,
  ) { this.managed = new NbSearchManagedCredentials(storage); }

  async export(config: NbSearchConfig | undefined, reuseLocalConfig: boolean): Promise<readonly SettingsTransferNbSearchCredential[]> {
    const entries = await this.managed.all();
    if (Object.keys(entries).length === 0) return [];
    return this.sources.withSource(reuseLocalConfig, config, (source) => {
      const effective = requireConfig(source);
      const resources: SettingsTransferNbSearchCredential[] = [];
      for (const [key, entry] of Object.entries(entries)) {
        if (!source.managedSlots?.includes(key) || !managedEntryMatches(entry, effective, key, source.env)) continue;
        resources.push({ kind: 'nbSearchCredential', key, binding: portableBinding(effective, key), value: entry.value });
      }
      return resources;
    });
  }

  inspect(config: NbSearchConfig | undefined, reuseLocalConfig: boolean, slotId: string): Promise<NbSearchTransferCredentialState> {
    return this.sources.withSource(reuseLocalConfig, config, async (source) => {
      const effective = requireConfig(source);
      const bindingVersion = managedBinding(effective, slotId, source.env);
      const { entry, version } = await this.managed.read(slotId);
      return { version, bindingVersion, binding: portableBinding(effective, slotId), value: entry?.value, active: managedEntryMatches(entry, effective, slotId, source.env), occupied: entry !== undefined || Object.hasOwn(source.env, effective.credential_slots[slotId]!.env) };
    });
  }

  async write(resource: SettingsTransferNbSearchCredential, version: string, bindingVersion: string): Promise<void> {
    const config = this.config.get<NbSearchConfig | undefined>('nbSearch');
    const reuse = this.config.get<{ reuse_local_config?: boolean } | undefined>('nbSearchSource')?.reuse_local_config ?? true;
    const before = await this.inspect(config, reuse, resource.key);
    if (before.version !== version || before.bindingVersion !== bindingVersion || !deepEqual(before.binding, resource.binding)) throw new ManagedCredentialError('changed');
    const instanceId = resource.binding.consumers[0]!.id;
    await this.service.writeManagedCredential(instanceId, resource.value, version, bindingVersion);
    const after = await this.inspect(config, reuse, resource.key);
    if (!after.active || after.value !== resource.value || !deepEqual(after.binding, resource.binding)) throw new ManagedCredentialError('changed');
  }
}

function requireConfig(source: NbSearchSource): CanonicalConfig {
  if (source.status.availability !== 'ready' || source.resolved === undefined) throw new ManagedCredentialError('unavailable');
  return source.resolved.config;
}

function portableBinding(config: CanonicalConfig, slotId: string): SettingsTransferNbSearchCredential['binding'] {
  const slot = config.credential_slots[slotId];
  if (slot === undefined) throw new ManagedCredentialError('binding');
  const consumers = Object.entries(config.provider_instances).flatMap(([id, instance]) => {
    if (instance.credential_slot_id !== slotId) return [];
    if (instance.provider_id !== slot.provider_id) throw new ManagedCredentialError('binding');
    return [{ id, baseUrl: instance.base_url ?? null }];
  }).toSorted((left, right) => left.id.localeCompare(right.id));
  if (consumers.length === 0) throw new ManagedCredentialError('binding');
  return { providerId: slot.provider_id, env: slot.env, consumers };
}

registerScopedService(LifecycleScope.App, INbSearchTransferCredentials, NbSearchTransferCredentials, ScopeActivation.OnDemand, 'settingsTransfer');
