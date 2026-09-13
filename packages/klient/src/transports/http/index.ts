import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { HttpChannel, type HttpChannelOptions } from './channel.js';

export { HTTP_REQUEST_BODY_LIMIT_BYTES } from './limits.js';

export {
  HTTP_TRANSPORT_TIMEOUT_REASON,
  HttpChannel,
  type HttpChannelOptions,
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
