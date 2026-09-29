import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISshCredentialStore {
  readonly _serviceBrand: undefined;
  save(hostId: string, kind: 'password' | 'passphrase' | 'identityFile', value: string, remember?: boolean): Promise<'keyring' | 'file' | 'memory'>;
  read(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<string | undefined>;
  forget(hostId: string, kind: 'password' | 'passphrase' | 'identityFile'): Promise<void>;
  savePrivateKey(hostId: string, contents: string): Promise<string>;
}

export const ISshCredentialStore: ServiceIdentifier<ISshCredentialStore> =
  createDecorator<ISshCredentialStore>('sshCredentialStore');
