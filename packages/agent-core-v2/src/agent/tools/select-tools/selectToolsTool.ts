import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { CALL_TOOL_NAME, IAgentToolSelectService, SELECT_TOOLS_TOOL_NAME } from '#/agent/toolSelect/toolSelect';

import {
  ISelectToolsTool,
  SelectToolsInputSchema,
  type SelectToolsInput,
} from './select-tools';

const DESCRIPTION =
  'Load MCP, plugin, or deferred builtin tools listed in <tools_added> by their exact names before using them. ' +
  'Fold the <tools_added> and <tools_removed> announcements in order to find the current names. ' +
  'A loaded tool\'s schema arrives with the next model step. If CallTool is in your tool list, run loaded tools through it ' +
  'with their name and arguments, because they are not added to the tool list; otherwise call them by their own name. ' +
  'Calling an announced tool before loading it does not run it; that error loads the tool and returns its parameter schema. ' +
  'Tools already in your tool list need no loading.';

export class SelectToolsTool implements ISelectToolsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = SELECT_TOOLS_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SelectToolsInputSchema);

  constructor(
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
  ) {}

  resolveExecution(args: SelectToolsInput): ToolExecution {
    return {
      description: `Loading ${args.names.join(', ')}`,
      approvalRule: this.name,
      execute: async (context) => {
        await this.registry.prepare(context.signal);
        if (!this.toolSelect.enabled()) {
          return {
            output: `${SELECT_TOOLS_TOOL_NAME} is not available for the current model.`,
            isError: true,
          };
        }
        const { toLoad, alreadyAvailable, unknown } = this.toolSelect.load(args.names);

        const lines: string[] = [];
        if (toLoad.length > 0) {
          const how = this.toolSelect.usesCallTool()
            ? `run each through ${CALL_TOOL_NAME} as {"name": "<tool>", "arguments": {...}}`
            : 'call each by its name';
          lines.push(`Loaded: ${toLoad.join(', ')}. Their schemas arrive with your next step; then ${how}.`);
        }
        if (alreadyAvailable.length > 0) {
          lines.push(`Already available: ${alreadyAvailable.join(', ')}`);
        }
        for (const name of unknown) {
          lines.push(this.registry.resolve(name) === undefined
            ? `Unknown tool: ${name}. Pick from the latest announced tools list.`
            : `Tool "${name}" is registered but is not loadable under the current tool policy. Check this agent's capability status; enabling a plugin or connection does not override its tool restrictions.`);
        }
        const isError = toLoad.length === 0 && alreadyAvailable.length === 0;
        return isError ? { output: lines.join('\n'), isError } : { output: lines.join('\n') };
      },
    };
  }
}

registerAgentToolService(ISelectToolsTool, SelectToolsTool, { name: SELECT_TOOLS_TOOL_NAME, domain: 'toolSelect' });
