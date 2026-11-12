import type { KikiClient } from '../../../lib/client';
import { PairSheet } from './PairSheet';

export function InviteSourceDialog({
  client,
  onClose,
  onInvited,
}: {
  client: KikiClient;
  onClose: () => void;
  onInvited: () => void;
}) {
  return <PairSheet client={client} direction="inbound" onClose={onClose} onInvited={onInvited} />;
}
