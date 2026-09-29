import { registerAgentToolService } from '@kiki/agent-core-v2';
import {
  IHistoryReadTool,
  IHistorySearchTool,
  HistoryReadTool,
  HistorySearchTool,
} from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import {
  IHistoryListTool,
  HistoryListTool,
} from '@kiki/agent-core-v2/agent/tools/history/historyListTool';

registerAgentToolService(IHistorySearchTool, HistorySearchTool, {
  name: 'HistorySearch', domain: 'history',
});
registerAgentToolService(IHistoryReadTool, HistoryReadTool, {
  name: 'HistoryRead', domain: 'history',
});
registerAgentToolService(IHistoryListTool, HistoryListTool, {
  name: 'HistoryList', domain: 'history',
});
