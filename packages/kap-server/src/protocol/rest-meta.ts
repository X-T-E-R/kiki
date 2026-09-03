import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { fsOpenInAppIdSchema } from './rest-fs';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  tasks: z.literal(true),
  terminal: z.literal(true).optional(),
  thread_communication: z.literal(true),
  transcript: z.literal(true).optional(),
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
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  started_at: isoDateTimeSchema,
  open_in_apps: z.array(fsOpenInAppIdSchema),
  dangerous_bypass_auth: z.boolean(),
  external_delegation: externalDelegationStateSchema,
  experimental_flags: z.record(z.string(), z.boolean()).optional(),
  backend: z.enum(['v1', 'v2']).optional(),
  web_title: z.string().optional(),
  features: z.array(metaFeatureSchema).optional(),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
