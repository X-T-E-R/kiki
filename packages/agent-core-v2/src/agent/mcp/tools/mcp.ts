import type { Tool as KosongTool } from '#/kosong/contract/tool';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes, toErrorMessage } from '#/errors';
import { isAbortError } from '#/_base/utils/abort';

import type { ExecutableTool, ExecutableToolContext } from '#/tool/toolContract';
import { mcpResultToExecutableOutput, type McpOutputOptions } from '#/agent/mcp/output';
import type { MCPClient, MCPToolResult } from '#/mcpCore/types';
import { computerToolDescription } from '#/mcpCore/computer';
import {
  isMcpConnectionClosedError,
  isMcpMalformedResultError,
  isMcpTransportFailure,
  probeMcpLiveness,
} from '#/mcpCore/client-shared';

interface McpToolOptions {
  readonly attachmentStore?: () => McpOutputOptions['attachmentStore'];
  readonly originalsDir?: string;
  readonly telemetry?: ITelemetryService;
  readonly providerType?: () => string | undefined;
  readonly reconnect?: (signal?: AbortSignal) => Promise<MCPClient | undefined>;
  readonly isRemoved?: () => boolean;
  readonly admitCall?: () => Promise<{ release(): void } | undefined>;
  readonly computerControl?: boolean;
  readonly serverName?: string;
  readonly onUnauthorized?: (error: unknown, client: MCPClient) => Promise<boolean>;
}

export function createMcpTool(
  qualifiedName: string,
  tool: KosongTool,
  client: MCPClient,
  options: McpToolOptions = {},
): ExecutableTool {
  const callTool = (activeClient: MCPClient, args: unknown, signal: AbortSignal) =>
    activeClient.callTool(tool.name, (args ?? {}) as Record<string, unknown>, signal);
  return {
    name: qualifiedName,
    description: options.computerControl === true ? computerToolDescription(tool.name, tool.description) : tool.description,
    parameters: tool.parameters,
    resolveExecution: (args) => ({
      approvalRule: qualifiedName,
      execute: async (context) => {
        if (options.isRemoved?.() === true) {
          return {
            output:
              `MCP server for tool "${qualifiedName}" has been removed ` +
              `(plugin uninstalled or config deleted). Do not call this tool again.`,
            isError: true,
          };
        }
        const lease = await options.admitCall?.();
        if (options.admitCall !== undefined && lease === undefined) {
          return { isError: true, output: `MCP tool "${qualifiedName}" is no longer available in this workspace. Refresh the tool list before calling it again.` };
        }
        try {
          let result;
          try {
            result = await callTool(client, args, context.signal);
          } catch (error) {
            await throwIfUnauthorized(options, qualifiedName, error, client, context.signal);
            result = await retryAfterReconnect(error, client, args, context, options, callTool, qualifiedName);
          }
          return await mcpResultToExecutableOutput(result, qualifiedName, {
            signal: context.signal,
            attachmentStore: options.attachmentStore?.(),
            originalsDir: options.originalsDir,
            telemetry: options.telemetry,
            providerType: options.providerType?.(),
            preserveStructuredContent: options.computerControl,
          });
        } finally {
          lease?.release();
        }
      },
    }),
  };
}

async function throwIfUnauthorized(
  options: McpToolOptions,
  qualifiedName: string,
  error: unknown,
  client: MCPClient,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || isAbortError(error)) return;
  if ((await options.onUnauthorized?.(error, client)) !== true) return;
  const serverName = options.serverName ?? qualifiedName;
  throw new Error2(
    ErrorCodes.MCP_OAUTH_FAILED,
    `MCP server "${serverName}" rejected the call with 401 Unauthorized and is now ` +
      `marked needs-auth. Authenticate the MCP server, then retry the original call.`,
    { cause: error },
  );
}

async function retryAfterReconnect(
  error: unknown,
  client: MCPClient,
  args: unknown,
  context: Pick<ExecutableToolContext, 'signal' | 'onUpdate'>,
  options: McpToolOptions,
  callTool: (client: MCPClient, args: unknown, signal: AbortSignal) => Promise<MCPToolResult>,
  qualifiedName: string,
): Promise<MCPToolResult> {
  const reconnect = options.reconnect;
  const isUnrecoverable = (e: unknown): boolean =>
    context.signal.aborted ||
    isAbortError(e) ||
    !isMcpTransportFailure(e) ||
    isMcpMalformedResultError(e);
  if (reconnect === undefined || isUnrecoverable(error)) {
    throw error;
  }
  if (options.computerControl === true) {
    throw new Error2(
      ErrorCodes.MCP_COMPUTER_OUTCOME_UNKNOWN,
      `${toErrorMessage(error)}. Computer action outcome is unknown; the call was not replayed. Reconnect and observe before a new action.`,
      { cause: error },
    );
  }

  let failure = error;
  if (!isMcpConnectionClosedError(failure)) {
    const alive = await probeMcpLiveness(client, context.signal);
    context.signal.throwIfAborted();
    if (alive) {
      try {
        return await callTool(client, args, context.signal);
      } catch (retryError) {
        await throwIfUnauthorized(options, qualifiedName, retryError, client, context.signal);
        if (isUnrecoverable(retryError)) {
          throw retryError;
        }
        failure = retryError;
      }
    }
  }

  context.onUpdate?.({ kind: 'status', text: 'MCP connection lost — reconnecting…' });
  let freshClient: MCPClient | undefined;
  try {
    freshClient = await reconnect(context.signal);
  } catch (reconnectError) {
    if (context.signal.aborted || isAbortError(reconnectError)) {
      throw reconnectError;
    }
    throw new Error2(
      ErrorCodes.MCP_STARTUP_FAILED,
      `${toErrorMessage(failure)} (reconnecting the MCP server also failed: ${toErrorMessage(reconnectError)})`,
      { cause: reconnectError },
    );
  }
  if (freshClient === undefined) {
    throw failure;
  }
  try {
    return await callTool(freshClient, args, context.signal);
  } catch (finalError) {
    await throwIfUnauthorized(options, qualifiedName, finalError, freshClient, context.signal);
    throw finalError;
  }
}
