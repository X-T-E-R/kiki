import { createKlientFromChannel, type Klient, type KlientOptions } from '../../core/klient.js';
import { HttpChannel, type HttpChannelOptions } from './channel.js';

export { HttpChannel, type HttpChannelOptions } from './channel.js';

export interface HttpKlientOptions extends KlientOptions, HttpChannelOptions {}

export function createKlient(options: HttpKlientOptions): Klient {
  return createKlientFromChannel(new HttpChannel(options), options);
}
