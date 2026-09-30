import { Event2 } from '@kiki/agent-core-v2';
import type { SearchMessagesResponse } from '../protocol/rest-search';

export class SearchIndexStateChanged extends Event2<{ payload: SearchMessagesResponse['index_state'] }> {
  static override readonly type = 'event.search.index_state_changed';
  static override readonly schema = undefined;
}
