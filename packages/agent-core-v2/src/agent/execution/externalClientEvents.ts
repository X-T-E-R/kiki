/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import type { ExternalClientSessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { Event2 } from '#/app/event/event2';

export type ExternalActivityPhase = 'started' | 'completed' | 'failed' | 'cancelled';

const externalClientSourceSchema = z.object({
  connectionId: z.string().min(1),
  clientName: z.string().min(1),
  sessionRef: z.string().min(1),
  driver: z.literal('external'),
});

const externalActivitySchema = z.object({
  activityId: z.string().min(1),
  phase: z.enum(['started', 'completed', 'failed', 'cancelled']),
  operationId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  turnId: z.number().int().nonnegative(),
  source: externalClientSourceSchema,
  input: z.unknown().optional(),
  error: z.string().optional(),
});

export interface ExternalActivityPayload extends z.infer<typeof externalActivitySchema> {}

export class ExternalActivity extends Event2<ExternalActivityPayload> {
  static override readonly type = 'external.activity';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = externalActivitySchema;
}
export interface ExternalActivity extends ExternalActivityPayload {}

const externalTextSchema = z.object({
  recordId: z.string().min(1),
  turnId: z.number().int().nonnegative(),
  text: z.string(),
  kind: z.enum(['note', 'user_excerpt', 'assistant_excerpt', 'handoff']),
  title: z.string().optional(),
  relatedOperationIds: z.array(z.string()).readonly().optional(),
  sourceUrl: z.string().optional(),
  clientTime: z.string().optional(),
  source: externalClientSourceSchema,
});

export interface ExternalTextPayload extends z.infer<typeof externalTextSchema> {}

export class ExternalText extends Event2<ExternalTextPayload> {
  static override readonly type = 'external.text';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = externalTextSchema;
}
export interface ExternalText extends ExternalTextPayload {}

export function externalClientOrigin(source: ExternalClientSessionMeta) {
  return { kind: 'external_client' as const, ...source };
}
