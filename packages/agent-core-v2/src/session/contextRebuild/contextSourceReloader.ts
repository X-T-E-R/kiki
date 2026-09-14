import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ContextSourceReloadResult {
  readonly instructionsChanged: boolean;
  readonly pluginsChanged: boolean;
}

export interface ISessionContextSourceReloader {
  readonly _serviceBrand: undefined;
  reload(): Promise<ContextSourceReloadResult>;
}

export const ISessionContextSourceReloader: ServiceIdentifier<ISessionContextSourceReloader> =
  createDecorator<ISessionContextSourceReloader>('sessionContextSourceReloader');

