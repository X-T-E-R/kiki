import { registerAgentToolService } from '@kiki/agent-core-v2';
import {
  IHistoryReadTool, IHistorySearchTool, HistoryReadTool, HistorySearchTool,
} from '@kiki/agent-core-v2/agent/tools/history/historyTools';

registerAgentToolService(IHistorySearchTool, HistorySearchTool, {
  name: 'HistorySearch', domain: 'history', disclosure: 'deferred',
});
registerAgentToolService(IHistoryReadTool, HistoryReadTool, {
  name: 'HistoryRead', domain: 'history', disclosure: 'deferred',
});
