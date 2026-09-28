import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const TOOL_SELECT_FLAG_ID = 'tool-select';
export const TOOL_SELECT_FLAG_ENV = 'KIKI_EXPERIMENTAL_TOOL_SELECT';

export const toolSelectFlag: FlagDefinitionInput = {
  id: TOOL_SELECT_FLAG_ID,
  title: 'Tool select (progressive tool disclosure)',
  description:
    'Keep MCP and plugin tool schemas out of top-level tools[]; SelectTools loads them into messages. Enabled by default for Kimi, OpenAI chat/responses, and Anthropic protocols when tool use is available.',
  env: TOOL_SELECT_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(toolSelectFlag);
