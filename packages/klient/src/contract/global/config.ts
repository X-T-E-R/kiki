/**
 * `configService` — layered global config service. Mirrors
 * `agent-core-v2/app/config/config.ts`.
 */

import { RequestIdentityPolicySchema } from '@moonshot-ai/agent-core-v2/kosong/requestIdentity/requestIdentityPolicy';
import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const configTargetSchema = z.enum(['user', 'memory']);

export const configInspectValueSchema = z.object({
  value: z.unknown().optional(),
  defaultValue: z.unknown().optional(),
  userValue: z.unknown().optional(),
  memoryValue: z.unknown().optional(),
});

export const configDiagnosticSchema = z.object({
  domain: z.string().optional(),
  severity: z.enum(['warning', 'error']),
  message: z.string(),
});

export const configSetInputSchema = z
  .tuple([z.string(), z.unknown(), configTargetSchema.optional()])
  .superRefine(([domain, value], ctx) => {
    if (domain === 'requestIdentity') {
      addRequestIdentityIssues(value, ctx, [1], false);
    }
  });

export const configReplaceInputSchema = z
  .tuple([z.string(), z.unknown(), configTargetSchema.optional()])
  .superRefine(([domain, value], ctx) => {
    if (domain === 'requestIdentity') {
      addRequestIdentityIssues(value, ctx, [1], true);
    }
  });

export const configReplaceSectionsInputSchema = z
  .tuple([z.record(z.string(), z.unknown()), configTargetSchema.optional()])
  .superRefine(([sections], ctx) => {
    if (Object.hasOwn(sections, 'requestIdentity')) {
      addRequestIdentityIssues(sections['requestIdentity'], ctx, [0, 'requestIdentity'], true);
    }
  });

function addRequestIdentityIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  allowClear: boolean,
): void {
  if (allowClear && (value === null || value === undefined)) return;
  const parsed = RequestIdentityPolicySchema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ ...issue, path: [...path, ...issue.path] });
  }
}

export const configContract = {
  get: { input: z.tuple([z.string()]), output: z.unknown() },
  inspect: { input: z.tuple([z.string()]), output: configInspectValueSchema },
  getAll: { input: z.tuple([]), output: z.record(z.string(), z.unknown()) },
  set: {
    input: configSetInputSchema,
    output: noResult,
  },
  replace: {
    input: configReplaceInputSchema,
    output: noResult,
  },
  replaceSections: {
    input: configReplaceSectionsInputSchema,
    output: noResult,
  },
  reload: { input: z.tuple([]), output: noResult },
  diagnostics: { input: z.tuple([]), output: z.array(configDiagnosticSchema) },
} satisfies ServiceContract;
