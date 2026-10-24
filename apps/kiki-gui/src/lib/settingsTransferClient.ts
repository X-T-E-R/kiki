import type { Klient } from '@kiki/klient';

export type SettingsTransferClient = Klient['global']['settingsTransfer'];

export function getSettingsTransferClient(klient: Pick<Klient, 'global'>): SettingsTransferClient {
  return klient.global.settingsTransfer;
}
