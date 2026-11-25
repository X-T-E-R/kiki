import type { Klient } from '../../core/klient.js';
import { createUnvalidatedKlientFromChannel } from '../../core/klient-lite.js';
import { HttpChannel, type HttpChannelOptions } from './channel.js';
import { createConnectionTransport } from './connections.js';

export { HTTP_REQUEST_BODY_LIMIT_BYTES } from './limits.js';
export { createConnectionTransport };
export {
  HTTP_TRANSPORT_TIMEOUT_REASON,
  HttpChannel,
  type HttpChannelOptions,
  type HttpTimeoutDetails,
  type HttpSocketCloseCause,
  type HttpSocketDiagnostic,
} from './channel.js';

export function createKlient(options: HttpChannelOptions): Klient {
  return createUnvalidatedKlientFromChannel(new HttpChannel({ validate: false, ...options }));
}

export function createRebindableKlient(options: HttpChannelOptions): {
  klient: Klient;
  rebind: (connection: Pick<HttpChannelOptions, 'endpoint' | 'token'>) => void;
  suspend: () => void;
} {
  const channel = new HttpChannel({ validate: false, ...options });
  return {
    klient: createUnvalidatedKlientFromChannel(channel),
    rebind: (connection) => channel.rebind(connection),
    suspend: () => channel.suspend(),
  };
}
