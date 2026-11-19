import type { KeyringApi } from '@kiki/oauth';

import {
  createAsyncSecretEntry,
  createSyncSecretEntry,
  isBrokerSecretBackendActive,
  listAsyncSecretAccounts,
  listSyncSecretAccounts,
  type SecretBackendConfig,
} from './secretBackend';

export function createKimiOAuthKeyring(config: SecretBackendConfig = {}): KeyringApi {
  return {
    get preferAsync() {
      return isBrokerSecretBackendActive(config);
    },
    createEntry(service, account) {
      return createSyncSecretEntry(service, account, config);
    },
    findAccounts(service) {
      return listSyncSecretAccounts(service, config);
    },
    createAsyncEntry(service, account) {
      return createAsyncSecretEntry(service, account, config);
    },
    findAccountsAsync(service) {
      return listAsyncSecretAccounts(service, config);
    },
  };
}

export const kimiOAuthKeyring: KeyringApi = createKimiOAuthKeyring();
