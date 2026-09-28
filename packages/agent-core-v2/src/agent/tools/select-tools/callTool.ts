import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { CALL_TOOL_NAME } from '#/agent/toolSelect/toolSelect';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';

const CallToolInputSchema = z.object({
  name: z.string().min(1).describe('The exact name of a tool previously loaded through SelectTools.'),
  arguments: z.record(z.string(), z.unknown()).describe('The loaded tool arguments as a JSON object.'),
}).strict();

export interface ICallTool extends AgentTool<z.infer<typeof CallToolInputSchema>> {}
export const ICallTool = createDecorator<ICallTool>('callTool');

export class CallTool implements ICallTool {
  declare readonly _serviceBrand: undefined;
  readonly name = CALL_TOOL_NAME;
  readonly description = 'Call a dynamic tool already loaded with SelectTools (MCP, plugin, or deferred builtin). Pass its exact name and arguments object. The call executes as the real tool with its own policy and approval; unavailable or unloaded names are rejected.';
  readonly parameters = toInputJsonSchema(CallToolInputSchema);

  resolveExecution(): ToolExecution {
    return {
      isError: true,
      output: 'This tool was not loaded or is no longer available. Call SelectTools with an announced name before retrying.',
    };
  }
}

registerAgentToolService(ICallTool, CallTool, { name: CALL_TOOL_NAME, domain: 'toolSelect' });
