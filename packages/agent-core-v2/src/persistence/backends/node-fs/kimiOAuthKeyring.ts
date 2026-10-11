import { createRequire } from 'node:module';

import type { KeyringApi, KeyringEntry } from '@kiki/oauth';

interface NativeKeyring {
  Entry: new (service: string, account: string, options?: unknown) => KeyringEntry;
  findCredentials(service: string): Array<{ readonly account: string }>;
}

function native(): NativeKeyring {
  return createRequire(import.meta.url)('@napi-rs/keyring') as NativeKeyring;
}

function linuxOptions(): unknown {
  return process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined;
}

export const kimiOAuthKeyring: KeyringApi = {
  createEntry(service, account) {
    return new (native().Entry)(service, account, linuxOptions());
  },
  findAccounts(service) {
    return native().findCredentials(service).map(({ account }) => account);
  },
};
