/**
 * `workspaceMcpConfig` domain — coded failures raised by validated MCP JSON
 * write-back.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const McpJsonWriteErrors = {
  codes: {
    MCP_WRITE_NOT_FOUND: 'mcp_json_write.not_found',
    MCP_WRITE_READ_ONLY: 'mcp_json_write.read_only',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(McpJsonWriteErrors);
