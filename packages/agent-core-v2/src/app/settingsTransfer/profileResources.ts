import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export class SettingsProfileResourceError extends Error {
  readonly code = 'settings_profile_resource.invalid';

  constructor(message = 'settings profile resource is invalid') {
    super(message);
    this.name = 'SettingsProfileResourceError';
  }
}

export interface SettingsProfileResource {
  readonly key: string;
  readonly text: string;
}

export interface ISettingsProfileResources {
  readonly _serviceBrand: undefined;
  list(): Promise<readonly SettingsProfileResource[]>;
  validate(resource: SettingsProfileResource): void;
  references(resource: SettingsProfileResource): readonly string[];
  read(key: string): Promise<string | undefined>;
  write(resource: SettingsProfileResource): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ISettingsProfileResources: ServiceIdentifier<ISettingsProfileResources> =
  createDecorator<ISettingsProfileResources>('settingsProfileResources');
