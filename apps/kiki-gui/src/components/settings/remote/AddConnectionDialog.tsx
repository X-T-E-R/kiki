import type { RemoteConnection, SshHost } from '@kiki/protocol';

import type { KikiClient } from '../../../lib/client';
import { PairSheet, type AddConnectionStart } from './PairSheet';

export type { AddConnectionStart };

export function AddConnectionDialog({
  client,
  sshProfiles,
  defaultHome,
  initial,
  onClose,
  onAdded,
}: {
  client: KikiClient;
  sshProfiles?: readonly SshHost[];
  defaultHome?: string;
  initial?: AddConnectionStart;
  onClose: () => void;
  onAdded: (record: RemoteConnection) => void;
}) {
  return (
    <PairSheet
      client={client}
      direction="outbound"
      sshProfiles={sshProfiles}
      defaultHome={defaultHome}
      initial={initial}
      onClose={onClose}
      onPaired={onAdded}
    />
  );
}
