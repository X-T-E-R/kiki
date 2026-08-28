/**
 * Pure mapping from the engine's session index summary to the SDK's
 * `SessionSummary`. One gap is bridged here: the engine's summary carries no
 * filesystem facts, so `workDir` / `sessionDir` come in as pre-resolved
 * `SessionSummaryFacts` (the caller derives them from `ISessionContext`,
 * `IBootstrapService.sessionDir`, and the workspace catalog). Everything else
 * is a field rename (`custom` ↔ `metadata`).
 */
import type { SessionSummary as V2SessionSummary } from '@moonshot-ai/agent-core-v2';

import { resolve, win32 } from 'node:path';

import type { JsonObject, SessionSummary } from '#/types';

/**
 * Work-dir key normalization: Windows-shaped paths resolve through `win32`
 * and fold to forward slashes, everything else resolves against the process
 * cwd. Must stay identical to the engine's own session-store key derivation.
 */
export function normalizeWorkDir(workDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return win32.resolve(workDir).replaceAll('\\', '/');
  }
  return resolve(workDir);
}

/** v1 summary fields the v2 index summary does not carry, resolved by the caller. */
export interface SessionSummaryFacts {
  readonly workDir: string;
  readonly sessionDir: string;
  readonly additionalDirs?: readonly string[];
}

export function v2SummaryToSessionSummary(
  summary: V2SessionSummary,
  facts: SessionSummaryFacts,
): SessionSummary {
  return {
    id: summary.id,
    title: summary.title,
    lastPrompt: summary.lastPrompt,
    workDir: facts.workDir,
    sessionDir: facts.sessionDir,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    archived: summary.archived,
    metadata: summary.custom as JsonObject | undefined,
    // The engine echoes additional dirs back exactly as the caller passed
    // them; every other path on a summary is forward-slashed, so normalize
    // here rather than making hosts branch on the platform.
    additionalDirs: facts.additionalDirs?.map(normalizeWorkDir),
    lastTurnReason: summary.lastTurnReason,
  };
}
