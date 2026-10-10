import { z } from 'zod';

export const connectionInputSchema = z.object({
  name: z.string().min(1).max(100),
  workspace: z.string().min(1).optional(),
  mode: z.enum(['manual', 'auto', 'review', 'yolo']).optional(),
  tools: z.array(z.string().min(1)).max(100).optional(),
  allowCommands: z.boolean().optional(),
  memoryScopes: z.array(z.enum(['workspace', 'global', 'persona', 'persona_workspace'])).optional(),
  historyScope: z.enum(['current', 'connection', 'workspace']).optional(),
}).strict();
export const connectionPatchSchema = connectionInputSchema.partial().extend({ enabled: z.boolean().optional() });
export const connectionSchema = connectionInputSchema.required({
  name: true, mode: true, tools: true, allowCommands: true, memoryScopes: true, historyScope: true,
}).extend({
  id: z.string(), status: z.enum(['active', 'paused', 'revoked']), createdAt: z.number(), updatedAt: z.number(),
});
export type ExternalClientConnection = z.infer<typeof connectionSchema>;
export const sessionSchema = z.object({ sessionId: z.string(), sessionRef: z.string(), connectionId: z.string(),
  clientName: z.string(), workspace: z.string(), workspaceId: z.string().optional(), conversationKey: z.string().optional(),
  permissionMode: z.enum(['manual', 'auto', 'review', 'yolo']).optional(),
  profile: z.string().optional(), profileFile: z.string().optional(),
  status: z.enum(['open', 'closed']), createdAt: z.number(), updatedAt: z.number(),
});
export type ExternalClientSession = z.infer<typeof sessionSchema>;
export interface ExternalClientOperation {
  readonly id: string;
  readonly connectionId: string;
  readonly sessionRef: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly hash: string;
  readonly idempotencyKey?: string;
  readonly acceptedAt: number;
  readonly updatedAt: number;
  readonly state: 'accepted' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled' | 'outcome_unknown';
  readonly result?: unknown;
  readonly error?: string;
}
export const saveTextSchema = z.object({ text: z.string().min(1).max(1_000_000),
  kind: z.enum(['note', 'user_excerpt', 'assistant_excerpt', 'handoff']), title: z.string().max(200).optional(),
  related_operation_ids: z.array(z.string()).max(100).optional(), source_url: z.string().url().optional(),
  client_time: z.string().optional(),
}).strict();
export const bridgeInputSchema = z.object({session_ref:z.string().regex(/^ext_[A-Za-z0-9_-]{1,200}$/).optional(),idempotency_key:z.string().min(1).max(256).optional()}).strict();
export const DEFAULT_EXTERNAL_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'ReadMediaFile',
  'AgentRun', 'AgentList', 'AgentSend', 'AgentNotify', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskWait',
  'HistoryList', 'HistoryRead', 'HistorySearch', 'MemoryRead', 'MemorySearch', 'MemoryWrite'];
export const READ_ONLY_EXTERNAL_TOOLS = new Set(['Read', 'Glob', 'Grep', 'ReadMediaFile', 'AgentList',
  'TaskList', 'TaskOutput', 'TaskWait', 'HistoryList', 'HistoryRead', 'HistorySearch', 'MemoryRead', 'MemorySearch']);
export { ExternalClientError } from '../mcp/externalClientTransport/host';
