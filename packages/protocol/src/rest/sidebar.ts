import { z } from 'zod';

import { personaAvatarDataSchema } from './persona';
import {
  sessionAttentionCursorSchema,
  sessionDeliverySchema,
  sessionForkedFromSchema,
  sessionPendingInteractionSchema,
  sessionPromotedFromSchema,
  sessionWorktreeSchema,
} from '../session';
import { isoDateTimeSchema } from '../time';
import { workspaceIdSchema } from '../workspace';

const sidebarBooleanQueryParam = /* @__PURE__ */ z.preprocess(
  (value) => {
    if (value === 'true' || value === '1' || value === 1 || value === true) return true;
    if (value === 'false' || value === '0' || value === 0 || value === false) return false;
    return value;
  },
  z.boolean().optional(),
);

export const sidebarSessionsSortSchema = /* @__PURE__ */ z.enum(['updated_desc', 'created_desc', 'title']);
export type SidebarSessionsSort = z.infer<typeof sidebarSessionsSortSchema>;

const sidebarFilterShape = {
  workspace_id: workspaceIdSchema.optional(),
  persona: z.string().min(1).optional(),
  busy: sidebarBooleanQueryParam,
  include_archive: sidebarBooleanQueryParam,
  archived_only: sidebarBooleanQueryParam,
  include_private: sidebarBooleanQueryParam,
  private_only: sidebarBooleanQueryParam,
  exclude_empty: sidebarBooleanQueryParam,
  pinned: sidebarBooleanQueryParam,
  q: z.string().max(500).optional(),
};

function refineSidebarFilters(
  value: {
    readonly archived_only?: boolean;
    readonly include_archive?: boolean;
    readonly private_only?: boolean;
    readonly include_private?: boolean;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.archived_only === true && value.include_archive === true) {
    ctx.addIssue({
      code: 'custom',
      message: 'archived_only and include_archive are mutually exclusive',
      path: ['archived_only'],
    });
  }
  if (value.private_only === true && value.include_private === false) {
    ctx.addIssue({
      code: 'custom',
      message: 'private_only and include_private are mutually exclusive',
      path: ['private_only'],
    });
  }
}

export const sidebarSessionsQuerySchema = /* @__PURE__ */ z
  .object({
    cursor: z.string().min(1).max(4096).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    member_limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: sidebarSessionsSortSchema.optional(),
    ...sidebarFilterShape,
  })
  .superRefine(refineSidebarFilters);
export type SidebarSessionsQuery = z.infer<typeof sidebarSessionsQuerySchema>;

export const sidebarGroupMembersQuerySchema = /* @__PURE__ */ z
  .object({
    cursor: z.string().min(1).max(4096).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    ...sidebarFilterShape,
  })
  .superRefine(refineSidebarFilters);
export type SidebarGroupMembersQuery = z.infer<typeof sidebarGroupMembersQuerySchema>;

export const sidebarRowGroupOriginSchema = /* @__PURE__ */ z.object({
  home_id: z.string().min(1).max(128),
  host_id: z.string().min(1).max(256),
  bridge_id: z.string().min(1).max(128).optional(),
});
export type SidebarRowGroupOrigin = z.infer<typeof sidebarRowGroupOriginSchema>;

export const sidebarExternalClientMarkSchema = /* @__PURE__ */ z.object({
  driver: z.literal('external'),
  connectionId: z.string().min(1).max(256),
  clientName: z.string().min(1).max(256),
  sessionRef: z.string().min(1).max(512),
});
export type SidebarExternalClientMark = z.infer<typeof sidebarExternalClientMarkSchema>;

export const sidebarRowSchema = /* @__PURE__ */ z.object({
  id: z.string().min(1),
  workspace_id: workspaceIdSchema,
  cwd: z.string().optional(),
  title: z.string(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  own_updated_at: isoDateTimeSchema,
  archived: z.boolean().optional(),
  archived_at: isoDateTimeSchema.optional(),
  private: z.boolean().optional(),
  pinned: z.boolean().optional(),
  busy: z.boolean(),
  executing: z.boolean().optional(),
  cleanup_pending: z.boolean().optional(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
  execution_phase: z.enum(['running', 'pausing', 'paused', 'resuming', 'failed']).optional(),
  delivery: sessionDeliverySchema.optional(),
  executor_id: z.string().optional(),
  persona_id: z.string().min(1).optional(),
  persona: personaAvatarDataSchema.optional(),
  bot_persona_id: z.string().min(1).optional(),
  room_persona_id: z.string().min(1).optional(),
  room_member_of: z.string().min(1).optional(),
  worktree: sessionWorktreeSchema.optional(),
  forked_from: sessionForkedFromSchema.optional(),
  promoted_from: sessionPromotedFromSchema.optional(),
  created_by_session_id: z.string().min(1).optional(),
  created_by_agent_id: z.string().min(1).optional(),
  child_session_kind: z.string().min(1).optional(),
  parent_session_id: z.string().min(1).optional(),
  external_client: sidebarExternalClientMarkSchema.optional(),
  last_seq: z.number().int().nonnegative(),
  attention_cursor: sessionAttentionCursorSchema.optional(),
  group_id: z.string().min(1).optional(),
  group_detached: z.boolean().optional(),
  group_origin: sidebarRowGroupOriginSchema.optional(),
});
export type SidebarRow = z.infer<typeof sidebarRowSchema>;

export const sidebarSessionUnitSchema = /* @__PURE__ */ z.object({
  kind: z.literal('session'),
  id: z.string().min(1),
  sort_at: z.number().int().nonnegative(),
  row: sidebarRowSchema,
});
export type SidebarSessionUnit = z.infer<typeof sidebarSessionUnitSchema>;

export const sidebarGroupUnitSchema = /* @__PURE__ */ z.object({
  kind: z.literal('group'),
  id: z.string().min(1),
  title: z.string(),
  opener_id: z.string().min(1).optional(),
  primary_workspace_id: workspaceIdSchema.optional(),
  sort_at: z.number().int().nonnegative(),
  has_pinned: z.boolean(),
  member_count: z.number().int().positive(),
  members: z.array(sidebarRowSchema),
  members_next_cursor: z.string().min(1).optional(),
});
export type SidebarGroupUnit = z.infer<typeof sidebarGroupUnitSchema>;

export const sidebarUnitSchema = /* @__PURE__ */ z.discriminatedUnion('kind', [
  sidebarSessionUnitSchema,
  sidebarGroupUnitSchema,
]);
export type SidebarUnit = z.infer<typeof sidebarUnitSchema>;

export const sidebarSessionsPageSchema = /* @__PURE__ */ z
  .object({
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative().optional(),
    units: z.array(sidebarUnitSchema),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).optional(),
    busy_count: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.has_more && value.next_cursor === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'next_cursor is required when has_more is true',
        path: ['next_cursor'],
      });
    }
  });
export type SidebarSessionsPage = z.infer<typeof sidebarSessionsPageSchema>;

export const sidebarGroupMembersResponseSchema = /* @__PURE__ */ z
  .object({
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative().optional(),
    group_id: z.string().min(1),
    member_count: z.number().int().nonnegative(),
    members: z.array(sidebarRowSchema),
    has_more: z.boolean(),
    next_cursor: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.has_more && value.next_cursor === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'next_cursor is required when has_more is true',
        path: ['next_cursor'],
      });
    }
  });
export type SidebarGroupMembersResponse = z.infer<typeof sidebarGroupMembersResponseSchema>;

export const resolveSidebarUnitsRequestSchema = /* @__PURE__ */ z
  .object({
    session_ids: z.array(z.string().min(1)).max(100).optional(),
    group_ids: z.array(z.string().min(1)).max(100).optional(),
    member_limit: z.number().int().min(1).max(100).optional(),
    ...sidebarFilterShape,
  })
  .strict()
  .superRefine(refineSidebarFilters);
export type ResolveSidebarUnitsRequest = z.infer<typeof resolveSidebarUnitsRequestSchema>;

export const resolveSidebarUnitsResponseSchema = /* @__PURE__ */ z.object({
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative().optional(),
  units: z.array(sidebarUnitSchema),
  missing_session_ids: z.array(z.string().min(1)),
  missing_group_ids: z.array(z.string().min(1)),
});
export type ResolveSidebarUnitsResponse = z.infer<typeof resolveSidebarUnitsResponseSchema>;

export const detachSessionGroupResponseSchema = /* @__PURE__ */ z.object({
  detached: z.boolean(),
  session_id: z.string().min(1),
  previous_group_id: z.string().min(1).optional(),
});
export type DetachSessionGroupResponse = z.infer<typeof detachSessionGroupResponseSchema>;
