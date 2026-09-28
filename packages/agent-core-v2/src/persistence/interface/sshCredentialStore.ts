import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISshCredentialStore {
  readonly _serviceBrand: undefined;
  save(hostId: string, kind: 'password' | 'passphrase', value: string, remember?: boolean): Promise<'keyring' | 'file' | 'memory'>;
  read(hostId: string, kind: 'password' | 'passphrase'): Promise<string | undefined>;
  forget(hostId: string, kind: 'password' | 'passphrase'): Promise<void>;
  savePrivateKey(hostId: string, contents: string): Promise<string>;
}

export const ISshCredentialStore: ServiceIdentifier<ISshCredentialStore> =
  createDecorator<ISshCredentialStore>('sshCredentialStore');
