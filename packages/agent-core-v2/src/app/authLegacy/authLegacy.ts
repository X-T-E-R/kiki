import {
  authSummarySchema,
  managedProviderStatusSchema,
  managedProviderSummarySchema,
  type AuthSummary,
  type ManagedProviderStatus,
  type ManagedProviderSummary,
} from '@kiki/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export {
  authSummarySchema,
  managedProviderStatusSchema,
  managedProviderSummarySchema,
  type AuthSummary,
  type ManagedProviderStatus,
  type ManagedProviderSummary,
};

export interface IAuthLegacyService {
  readonly _serviceBrand: undefined;

  get(): Promise<AuthSummary>;
}

export const IAuthLegacyService: ServiceIdentifier<IAuthLegacyService> =
  createDecorator<IAuthLegacyService>('authLegacyService');
