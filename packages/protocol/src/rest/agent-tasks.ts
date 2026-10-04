import { z } from 'zod';
import { taskSchema } from '../task';
import { isoDateTimeSchema } from '../time';

export const listAgentTasksQuerySchema = z.object({
  page_size: z.coerce.number().int().min(1).max(100).optional(),
  page_token: z.string().min(1).optional(),
});
export type ListAgentTasksQuery = z.infer<typeof listAgentTasksQuerySchema>;

export const agentTaskSummarySchema = taskSchema.extend({
  owner_agent_id: z.string().min(1),
  source: z.enum(['live', 'persisted']),
});
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;

export const agentTasksFailureSchema = z.object({
  owner_agent_id: z.string().optional(),
  task_id: z.string().optional(),
  stage: z.enum(['inventory', 'owner', 'task_metadata']),
  message: z.string(),
});
export type AgentTasksFailure = z.infer<typeof agentTasksFailureSchema>;

/**
 * Read-only session task metadata with cumulative owner coverage across pages.
 * Pending owners have not been fully read; complete owners absent from the accumulated
 * items across all pages are empty.
 * If inventory_complete is false, total_owners counts only the known inventory.
 * Failures retain the first diagnostic per failed owner, plus inventory diagnostics.
 * Follow next_page_token until has_more is false. Invalidated tokens require a fresh
 * scan, discarding previously collected pages. Refresh the scan for later updates.
 * Persisted running states are historical registrations, not proof of live execution;
 * persisted receipt bytes are metadata and their contents are not re-verified here.
 */
export const listAgentTasksResponseSchema = z.object({
  items: z.array(agentTaskSummarySchema),
  owners: z.array(z.object({
    owner_agent_id: z.string().min(1),
    source: z.enum(['live', 'persisted']),
    state: z.enum(['complete', 'pending', 'failed']),
  })),
  coverage: z.object({
    total_owners: z.number().int().nonnegative(),
    completed_owners: z.number().int().nonnegative(),
    failed_owners: z.number().int().nonnegative(),
    pending_owners: z.number().int().nonnegative(),
    inventory_complete: z.boolean(),
    complete: z.boolean(),
    failures: z.array(agentTasksFailureSchema),
  }),
  has_more: z.boolean(),
  next_page_token: z.string().optional(),
  partial: z.boolean(),
  /** Each owner is sampled as pagination reaches it; this is not an atomic or cached tree snapshot. */
  consistency: z.literal('incremental'),
  started_at: isoDateTimeSchema,
  observed_at: isoDateTimeSchema,
}).superRefine((page, ctx) => {
  const counts = page.coverage;
  const ownerIds = new Set(page.owners.map((owner) => owner.owner_agent_id));
  if (counts.total_owners !== page.owners.length || ownerIds.size !== page.owners.length ||
      counts.completed_owners !== page.owners.filter((owner) => owner.state === 'complete').length ||
      counts.failed_owners !== page.owners.filter((owner) => owner.state === 'failed').length ||
      counts.pending_owners !== page.owners.filter((owner) => owner.state === 'pending').length) {
    ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'Owner coverage does not match the reported inventory' });
  }
  if (page.has_more !== (page.next_page_token !== undefined) ||
      page.partial !== (!counts.inventory_complete || counts.failed_owners > 0) ||
      counts.complete !== (!page.has_more && !page.partial && counts.pending_owners === 0)) {
    ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'Coverage, failures and continuation disagree' });
  }
  if (page.items.some((item) => !ownerIds.has(item.owner_agent_id))) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'Task owner is absent from the reported inventory' });
  }
});
export type ListAgentTasksResponse = z.infer<typeof listAgentTasksResponseSchema>;
