import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IInheritedAgentProfileLoader {
  readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  reload(): Promise<void>;
}

export const IInheritedAgentProfileLoader: ServiceIdentifier<IInheritedAgentProfileLoader> =
  createDecorator<IInheritedAgentProfileLoader>('inheritedAgentProfileLoader');
