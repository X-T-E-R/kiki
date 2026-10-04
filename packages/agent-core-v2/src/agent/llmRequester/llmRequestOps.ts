/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import { defineState } from '#/state/state';

export interface LlmRequestToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface LlmRequestTraceState {
  readonly seenToolsHashes: readonly string[];
  readonly advertisedProfiles?: readonly { readonly name: string; readonly line: string; readonly signature: string }[];
  readonly lastRequest?: import('@kiki/protocol').AgentPromptRequest;
}

const llmToolEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const llmToolsSnapshotSchema = z.object({
  hash: z.string(),
  tools: z.array(llmToolEntrySchema).readonly(),
});

export class LlmToolsSnapshot extends Event2<z.infer<typeof llmToolsSnapshotSchema>> {
  static override readonly type = 'llm.tools_snapshot';
  static override readonly durable = true;
  static override readonly schema = llmToolsSnapshotSchema;
}
export interface LlmToolsSnapshot extends z.infer<typeof llmToolsSnapshotSchema> {}

const llmRequestSchema = z.object({
  kind: z.enum(['loop', 'compaction']),
  provider: z.string(),
  model: z.string(),
  modelAlias: z.string().optional(),
  thinkingEffort: z.custom<ThinkingEffort>().optional(),
  thinkingKeep: z.string().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  maxTokens: z.number().optional(),
  betaApi: z.boolean().optional(),
  toolSelect: z.boolean(),
  systemPromptHash: z.string(),
  systemPrompt: z.string().optional(),
  toolsHash: z.string(),
  messageCount: z.number(),
  turnStep: z.string().optional(),
  attempt: z.string().optional(),
  projection: z.enum(['strict', 'media-degraded', 'media-stripped', 'strict-media-degraded', 'strict-media-stripped']).optional(),
  droppedCount: z.number().optional(),
  anchorApplied: z.boolean().optional(),
  cognitionRevision: z.number().int().optional(),
  bindingRevision: z.string().optional(),
  anchorSteps: z.number().int().positive().optional(),
  anchorScope: z.enum(['session', 'turn']).optional(),
  advertisedProfiles: z.array(z.object({ name: z.string(), line: z.string(), signature: z.string() })).readonly().optional(),
});

export type LlmRequestPayload = z.infer<typeof llmRequestSchema>;

export class LlmRequest extends Event2<LlmRequestPayload> {
  static override readonly type = 'llm.request';
  static override readonly durable = true;
  static override readonly schema = llmRequestSchema;
}
export interface LlmRequest extends LlmRequestPayload {}

export function promptRequestEvidence(e: LlmRequest): import('@kiki/protocol').AgentPromptRequest {
  return {
    system_prompt_hash: e.systemPromptHash, tools_hash: e.toolsHash, model_alias: e.modelAlias,
    turn_step: e.turnStep, attempt: e.attempt, at: e.time, anchor_applied: e.anchorApplied,
    cognition_revision: e.cognitionRevision, binding_revision: e.bindingRevision,
    anchor_steps: e.anchorSteps, anchor_scope: e.anchorScope,
  };
}

export const llmRequestTraceKey = defineState(
  'llm.requestTrace',
  (): LlmRequestTraceState => ({ seenToolsHashes: [] }),
).replayable({ schema: z.custom<LlmRequestTraceState>() })
  .on(LlmToolsSnapshot, (s, e) => {
    if (s.seenToolsHashes.includes(e.hash)) return;
    s.seenToolsHashes = [...s.seenToolsHashes, e.hash];
  })
  .on(LlmRequest, (s, e) => {
    s.lastRequest = promptRequestEvidence(e);
    if (e.kind === 'loop') s.advertisedProfiles = e.advertisedProfiles?.map((entry) => ({ ...entry }));
  });
