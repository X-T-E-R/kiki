import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { CALL_TOOL_NAME, IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
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
  readonly description = 'After SelectTools has loaded an MCP, plugin, or deferred builtin tool, use CallTool to run it by exact name with its JSON arguments. Use ordinary tools directly; never use CallTool for names absent from the folded <tools_added>/<tools_removed> announcements. The real tool retains its permission checks. A name that is announced but not yet loaded is not run: the error loads that tool and returns its parameter schema. Any other unavailable name returns an error that says why.';
  readonly parameters = toInputJsonSchema(CallToolInputSchema);

  constructor(@IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService) {}

  resolveExecution(args: z.infer<typeof CallToolInputSchema>): ToolExecution {
    return { isError: true, output: this.toolSelect.describeCallToolTarget(args.name) };
  }
}

registerAgentToolService(ICallTool, CallTool, { name: CALL_TOOL_NAME, domain: 'toolSelect' });
