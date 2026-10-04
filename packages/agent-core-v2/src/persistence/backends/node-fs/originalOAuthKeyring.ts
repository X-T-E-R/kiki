import { createRequire } from 'node:module';
import type { OriginalOAuthKeyring } from '@kiki/oauth';

function entry(service: string, account: string): import('@napi-rs/keyring').AsyncEntry {
  const { AsyncEntry } = createRequire(import.meta.url)('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  return new AsyncEntry(service, account, process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
}

export const originalOAuthKeyring: OriginalOAuthKeyring = {
  load: (service, account) => entry(service, account).getPassword(),
  save: (service, account, value) => entry(service, account).setPassword(value),
};
