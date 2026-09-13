/**
 * MCP JSON management REST schemas.
 *
 * Covers listing and mutating the editable user/project MCP server entries.
 */

import { McpServerConfigSchema } from '@kiki/agent-core-v2';
import { z } from 'zod';

export const mcpJsonWriteScopeSchema = z.enum(['user', 'project']);

export const mcpJsonServerEntrySchema = z.object({
  name: z.string().trim().min(1).max(256),
  scope: mcpJsonWriteScopeSchema,
  config: McpServerConfigSchema,
});
export type McpJsonServerEntry = z.infer<typeof mcpJsonServerEntrySchema>;

export const listMcpJsonServersQuerySchema = z.object({
  workspace_id: z.string().min(1),
}).strict();

export const listMcpJsonServersResponseSchema = z.object({
  entries: z.array(mcpJsonServerEntrySchema),
});
export type ListMcpJsonServersResponse = z.infer<typeof listMcpJsonServersResponseSchema>;

export const mcpJsonServerNameParamsSchema = z.object({
  name: z.string().trim().min(1).max(256),
}).strict();

export const upsertMcpJsonServerRequestSchema = z.object({
  workspace_id: z.string().min(1),
  scope: mcpJsonWriteScopeSchema,
  config: McpServerConfigSchema,
}).strict();
export type UpsertMcpJsonServerRequest = z.infer<typeof upsertMcpJsonServerRequestSchema>;

export const removeMcpJsonServerQuerySchema = z.object({
  workspace_id: z.string().min(1),
  scope: mcpJsonWriteScopeSchema,
}).strict();
