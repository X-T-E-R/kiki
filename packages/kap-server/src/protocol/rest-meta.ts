import { z } from 'zod';
import { spaceIdSchema } from '@kiki/protocol';

import { isoDateTimeSchema } from '@kiki/agent-core-v2/_base/utils/isoDateTime';

import { fsOpenInAppIdSchema } from './rest-fs';

export const metaCapabilitiesSchema = z.object({
  websocket: z.boolean(),
  file_upload: z.boolean(),
  fs_query: z.boolean(),
  mcp: z.boolean(),
  tasks: z.boolean(),
  terminal: z.boolean().optional(),
  thread_communication: z.boolean(),
  transcript: z.boolean().optional(),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaFeatureStateSchema = z.enum([
  'Pending',
  'Activating',
  'Active',
  'Unloading',
  'Failed',
]);

export const metaFeatureSchema = z.object({
  name: z.string().min(1),
  state: metaFeatureStateSchema,
  meta: z.record(z.string(), z.unknown()),
});

export type MetaFeature = z.infer<typeof metaFeatureSchema>;

const externalDelegationDisabledReasonSchema = z.enum([
  'feature_disabled',
  'session_index_unavailable',
  'workspace_drift',
  'bootstrap_failed',
]);

export const externalDelegationStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('active') }),
  z.object({
    state: z.literal('disabled'),
    reason: externalDelegationDisabledReasonSchema,
    message: z.string().min(1).optional(),
  }),
  z.object({ state: z.literal('not_configured') }),
]);

export type ExternalDelegationState = z.infer<typeof externalDelegationStateSchema>;

export const metaResponseSchema = z.object({
  server_version: z.string().min(1),
  build_id: z.string().min(1).optional(),
  build_channel: z.string().min(1).optional(),
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  server_home_id: z.string().uuid().optional(),
  current_space_id: z.union([z.literal('main'), spaceIdSchema]).optional(),
  started_at: isoDateTimeSchema,
  open_in_apps: z.array(fsOpenInAppIdSchema),
  dangerous_bypass_auth: z.boolean(),
  external_delegation: externalDelegationStateSchema,
  experimental_flags: z.record(z.string(), z.boolean()).optional(),
  desktop_managed: z.boolean().optional(),
  backend: z.enum(['v1', 'v2']).optional(),
  web_title: z.string().optional(),
  features: z.array(metaFeatureSchema).optional(),
  storage_mode: z.enum(['maintenance', 'normal']).optional(),
  storage_status_path: z.literal('/api/storage').optional(),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
