import type { OriginalOAuthKeyring } from '@kiki/oauth';

import { createAsyncSecretEntry, type SecretBackendConfig } from './secretBackend';

export function createOriginalOAuthKeyring(config: SecretBackendConfig = {}): OriginalOAuthKeyring {
  return {
    load: async (service, account) => (await (await createAsyncSecretEntry(service, account, config)).getPassword()) ?? undefined,
    save: async (service, account, value) => (await createAsyncSecretEntry(service, account, config)).setPassword(value),
  };
}

export const originalOAuthKeyring: OriginalOAuthKeyring = createOriginalOAuthKeyring();
