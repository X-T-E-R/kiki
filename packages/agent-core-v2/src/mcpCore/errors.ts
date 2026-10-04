import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const McpErrors = {
  codes: {
    MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
    MCP_SERVER_DISABLED: 'mcp.server_disabled',
    MCP_STARTUP_FAILED: 'mcp.startup_failed',
    MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',
    MCP_OAUTH_FAILED: 'mcp.oauth_failed',
    MCP_COMPUTER_BUSY: 'mcp.computer_busy',
    MCP_COMPUTER_OUTCOME_UNKNOWN: 'mcp.computer_outcome_unknown',
    MCP_COMPUTER_STOP_UNCONFIRMED: 'mcp.computer_stop_unconfirmed',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(McpErrors);
