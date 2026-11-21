import { Event2 } from '@kiki/agent-core-v2';
import type { RemoteConnectionsChangedEvent } from '@kiki/protocol';

export class RemoteConnectionsChanged extends Event2<{ payload: Omit<RemoteConnectionsChangedEvent, 'type'> }> {
  static override readonly type = 'event.remote_connections.changed';
  static override readonly schema = undefined;
}
