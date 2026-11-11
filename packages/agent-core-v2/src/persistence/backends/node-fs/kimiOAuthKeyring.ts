import type { KeyringApi } from '@kiki/oauth';

import {
  createSyncSecretEntry,
  listSyncSecretAccounts,
  type SecretBackendConfig,
} from './secretBackend';

export function createKimiOAuthKeyring(config: SecretBackendConfig = {}): KeyringApi {
  return {
    createEntry(service, account) {
      return createSyncSecretEntry(service, account, config);
    },
    findAccounts(service) {
      return listSyncSecretAccounts(service, config);
    },
  };
}

export const kimiOAuthKeyring: KeyringApi = createKimiOAuthKeyring();
