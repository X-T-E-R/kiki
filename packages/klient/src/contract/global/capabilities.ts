/**
 * `capabilityService` — built-in product capability readiness and install
 * orchestration. Mirrors `agent-core-v2/app/capability/types.ts`.
 */

import { z } from 'zod';

import type { ServiceContract } from '../types.js';

export const capabilityStepSchema = z.object({
  id: z.string(),
  state: z.enum(['ok', 'missing', 'failed']),
  // Additive: a server that predates `reason` still parses, and a reason this
  // client does not know degrades to the step's state instead of raw prose.
  reason: z.string().optional(),
  detail: z.string().optional(),
  optional: z.boolean().optional(),
});

export const capabilityInstallProgressSchema = z.object({
  running: z.boolean(),
  step: z.string().optional(),
  percent: z.number().optional(),
  error: z.string().optional(),
  note: z.string().optional(),
});

export const capabilityStatusSchema = z.object({
  id: z.enum(['kimi-cu', 'kimi-webbridge', 'kiki-computer', 'kiki-browser']),
  pluginId: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supported: z.boolean(),
  state: z.enum(['not_installed', 'partial', 'ready', 'unsupported']),
  version: z.string().optional(),
  steps: z.array(capabilityStepSchema),
  plan: z.object({
    artifact: z.object({ version: z.string(), url: z.string(), sha256: z.string(), metadataUrl: z.string(), maxBytes: z.number() }),
    destination: z.string(), browserExtensionUrl: z.string().optional(), note: z.string(),
  }).optional(),
  install: capabilityInstallProgressSchema,
});

export const capabilitiesContract = {
  listCapabilities: { input: z.tuple([]), output: z.array(capabilityStatusSchema) },
  getCapability: { input: z.tuple([z.string()]), output: capabilityStatusSchema },
  installCapability: { input: z.tuple([z.string(), z.string().optional(), z.enum(['driver-only', 'managed-browser']).optional()]), output: capabilityStatusSchema },
  cancelCapability: { input: z.tuple([z.string()]), output: capabilityStatusSchema },
} satisfies ServiceContract;
