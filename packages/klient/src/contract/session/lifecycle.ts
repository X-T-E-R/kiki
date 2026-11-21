/**
 * `sessionManager` — App-scope session lifecycle after the Workspace-domain
 * split. It creates, resumes, closes, archives, restores, deletes, and forks
 * sessions through the App-owned manager; the engine returns scope handles and
 * the wire keeps their serializable `{ id, kind }` fields.
 */

import { z } from 'zod';
import { executionSelectionWireSchema as executionSelectionSchema } from '../execution.js';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { lazyContract } from '../lazyContract.js';

export const createSessionOptionsSchema = /* @__PURE__ */ z.object({
  sessionId: z.string().optional(),
  localSession: z.object({ localId: z.string(), executorId: z.string(), engine: z.enum(['claude', 'codex']),
    externalId: z.string(), home: z.string() }).optional(),
  workDir: z.string(),
  ephemeral: z.boolean().optional(),
  private: z.boolean().optional(),
  delivery: z.enum(['reply', 'message']).optional(),
  additionalDirs: z.array(z.string()).optional(),
  waitForSessionMs: z.number().nonnegative().finite().optional(),
  mainAgentBinding: z.object({
    execution: executionSelectionSchema.optional(),
    persona: z.string().optional(),
    profile: z.string().optional(), model: z.string().optional(), thinking: z.string().nullable().optional(),
  }).optional(),
  /**
   * Ephemeral per-session MCP servers (engine `CreateSessionOptions.mcpServers`):
   * connected only for the created session, never persisted.
   */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

/** Same fields as `ResumeSessionOptions` in the engine — keep in sync. */
export const resumeSessionOptionsSchema = /* @__PURE__ */ z.object({
  additionalDirs: z.array(z.string()).optional(),
  waitForSessionMs: z.number().nonnegative().finite().optional(),
  /**
   * Ephemeral per-session MCP servers, applied when resume re-materializes a
   * cold session (ignored when the session is already live).
   */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

/** Same fields as `ForkSessionOptions` in the engine — keep in sync. */
export const sessionSeedModeWireSchema = /* @__PURE__ */ z.enum(['fresh', 'compact', 'verbatim']);
export const sessionSeedCarryWireSchema = /* @__PURE__ */ z.union([
  z.object({ last: z.number().int().nonnegative() }).strict(),
  z.object({ fromMessageId: z.string().min(1) }).strict(),
]);

export const forkSessionOptionsSchema = /* @__PURE__ */ z.object({
  sourceSessionId: z.string(),
  newSessionId: z.string().optional(),
  private: z.boolean().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turnIndex: z.number().optional(),
  throughUserMessage: z.boolean().optional(),
  throughMessageId: z.string().optional(),
  externalMaterialOnly: z.boolean().optional(),
  seed: sessionSeedModeWireSchema.optional(),
  carry: sessionSeedCarryWireSchema.optional(),
});

/** Same fields as `ForkSessionOptions` in the engine, minus the fork-only truncation. */
export const createChildSessionOptionsSchema = /* @__PURE__ */ forkSessionOptionsSchema.omit({
  turnIndex: true,
  throughUserMessage: true,
  throughMessageId: true,
  externalMaterialOnly: true,
  seed: true,
  carry: true,
});

/** `IScopeHandle` as it survives JSON — `{ id, kind }` plus extras. */
export const handleWireSchema = /* @__PURE__ */ z.looseObject({
  id: z.string(),
  kind: z.string(),
});

export const agentLifecycleContract = {
  countPendingBackgroundTasks: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([]), output: /* @__PURE__ */ z.number() }), 'input', 'output'),
  drainBackgroundTasks: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.number().positive().finite()]), output: noResult }), 'input', 'output'),
} satisfies ServiceContract;

export const sessionManagerContract = {
  create: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createSessionOptionsSchema]), output: handleWireSchema }), 'input', 'output'),
  resume: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: /* @__PURE__ */ maybe(handleWireSchema),
  }), 'input', 'output'),
  close: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  archive: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  restore: /* @__PURE__ */ lazyContract(() => ({
    input: /* @__PURE__ */ z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: /* @__PURE__ */ maybe(handleWireSchema),
  }), 'input', 'output'),
  delete: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([z.string()]), output: noResult }), 'input', 'output'),
  fork: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([forkSessionOptionsSchema]), output: handleWireSchema }), 'input', 'output'),
  createChild: /* @__PURE__ */ lazyContract(() => ({ input: /* @__PURE__ */ z.tuple([createChildSessionOptionsSchema]), output: handleWireSchema }), 'input', 'output'),
} satisfies ServiceContract;
