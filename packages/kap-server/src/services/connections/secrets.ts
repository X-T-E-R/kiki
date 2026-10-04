import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateFile, writePrivateFile } from '../auth/privateFiles';
export type ConnectionSecretPurpose = 'gui' | 'bridge';
export interface ConnectionSecretRef { connectionId: string; purpose: ConnectionSecretPurpose }
export class ConnectionSecretStore {
  constructor(private readonly homeDir: string) {}
  async read<T>(ref: ConnectionSecretRef): Promise<T> { return JSON.parse((await readPrivateFile(this.path(ref))).toString('utf8')) as T; }
  async write<T>(ref: ConnectionSecretRef, value: T): Promise<void> { await writePrivateFile(this.path(ref), JSON.stringify(value)); }
  async remove(ref: ConnectionSecretRef): Promise<void> { await rm(this.path(ref), { force: true }); }
  private path(ref: ConnectionSecretRef): string {
    if (!/^[0-9a-f-]{36}$/.test(ref.connectionId) || !['gui', 'bridge'].includes(ref.purpose)) throw new Error('Invalid connection credential reference');
    return join(this.homeDir, 'server', 'connection-secrets', ref.connectionId + '.' + ref.purpose + '.json');
  }
}
