import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SkillSource } from '#/app/skillCatalog/types';
import type { HookDef } from '../internal/types';

export interface SkillHookRegistration {
  readonly skillName: string;
  readonly skillPath: string;
  readonly source: SkillSource;
  readonly pluginId?: string;
  readonly hooks: readonly HookDef[];
}

export interface ISessionExternalHooksService {
  readonly _serviceBrand: undefined;
  registerSkillHooks(registration: SkillHookRegistration): void;
  getSkillHooks(): Promise<readonly HookDef[]>;
}

export const ISessionExternalHooksService: ServiceIdentifier<ISessionExternalHooksService> =
  createDecorator<ISessionExternalHooksService>('sessionExternalHooksService');
