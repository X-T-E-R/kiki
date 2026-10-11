import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { HttpChannel, type HttpChannelOptions } from './channel.js';
import { createConnectionTransport } from './connections.js';

export { HTTP_REQUEST_BODY_LIMIT_BYTES } from './limits.js';
export { createConnectionTransport };
export type { ConnectionsFacade } from '../../core/facade/connections.js';

export {
  HTTP_TRANSPORT_TIMEOUT_REASON,
  HttpChannel,
  type HttpChannelOptions,
  type HttpTimeoutDetails,
  type HttpSocketCloseCause,
  type HttpSocketDiagnostic,
} from './channel.js';
export type {
  HttpRestBinaryFile,
  HttpRestConfigPatch,
  HttpRestFacade,
  HttpRestListSessionsQuery,
  HttpRestPluginMarketplaceEntry,
  HttpRestPluginMarketplaceResponse,
  HttpRestRequestOptions,
  HttpRestSearchMessageHit,
  HttpRestSearchMessagesBody,
  HttpRestSearchMessagesResponse,
  HttpRestSessionArchive,
} from '../../core/facade/http-rest.js';

export interface HttpKlientOptions extends KlientOptions, HttpChannelOptions {}

export function createKlient(options: HttpKlientOptions): Klient {
  return createKlientFromChannel(new HttpChannel(options), options);
}
/** Use a registered source-home connection without exposing its remote credentials. */
export function createConnectionKlient(options: HttpKlientOptions & { connectionId: string }): Klient {
  return createKlient({ ...options, ...createConnectionTransport(options) });
}
