import { registerAgentToolService } from '@kiki/agent-core-v2/agent/toolRegistry/toolContribution';
import { BOARD_TOOL_CONTRIBUTIONS } from '@kiki/agent-core-v2/agent/tools/board/boardTools';

const [read, write] = BOARD_TOOL_CONTRIBUTIONS;
registerAgentToolService(read.id, read.ctor, read.options);
registerAgentToolService(write.id, write.ctor, write.options);
