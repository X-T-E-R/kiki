import { z } from 'zod';

import { envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

/** `workspaceInstance` domain — the App-level idle TTL applied after the final live-session
 *  reference is released, with an environment override for embedding hosts. */
export const WORKSPACE_INSTANCE_SECTION = 'workspaceInstance';
export const DEFAULT_WORKSPACE_IDLE_TTL_MS = 5 * 60 * 1000;
export const WORKSPACE_IDLE_TTL_ENV = 'KIKI_WORKSPACE_IDLE_TTL_MS';

export const WorkspaceInstanceConfigSchema = z
  .object({
    idleTtlMs: z.number().int().min(0).optional(),
  })
  .strict();

export type WorkspaceInstanceConfig = z.infer<typeof WorkspaceInstanceConfigSchema>;

function parseIdleTtlMs(raw: string): number | undefined {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export const workspaceInstanceEnvBindings = envBindings(WorkspaceInstanceConfigSchema, {
  idleTtlMs: { env: WORKSPACE_IDLE_TTL_ENV, parse: parseIdleTtlMs },
});

export const stripWorkspaceInstanceEnv = stripEnvBoundFields(workspaceInstanceEnvBindings);

registerConfigSection(WORKSPACE_INSTANCE_SECTION, WorkspaceInstanceConfigSchema, {
  defaultValue: { idleTtlMs: DEFAULT_WORKSPACE_IDLE_TTL_MS },
  env: workspaceInstanceEnvBindings,
  stripEnv: stripWorkspaceInstanceEnv,
});
