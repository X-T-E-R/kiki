import { contextProcedureTable, delegationProcedureTable } from '@kiki/klient/procedures';
import type { NamedAgentProfile } from '@kiki/protocol';

/** One `kiki_context` group; `hooks` adds no tool, it injects context. */
export type KikiContextGroup = NonNullable<NamedAgentProfile['kiki_context']>[number];

/** Tool groups in the order the editor lists them; hooks come last, on their own. */
export const KIKI_TOOL_GROUPS = ['memory', 'board', 'cron', 'threads', 'history'] as const satisfies readonly KikiContextGroup[];

/** The MCP tool names a group hands the engine, from the bridge's own table. */
export function kikiGroupTools(group: KikiContextGroup): string[] {
  return contextProcedureTable.filter((entry) => entry.group === group).map((entry) => entry.toolName);
}

/** Every MCP tool the delegation bridge (`allow_kiki_subagents`) hands the engine. */
export function kikiDelegationTools(): string[] {
  return delegationProcedureTable.map((procedure) => procedure.mcp.toolName);
}

/** Which harness family the hook bridge writes config for; mirrors kap-server's `createHarnessHooks`. */
export type HookHarness = 'claude' | 'codex' | 'grok' | 'antigravity';

export function hookHarnessOf(executorId: string): HookHarness | undefined {
  if (executorId.startsWith('claude')) return 'claude';
  if (executorId.startsWith('codex')) return 'codex';
  if (executorId.startsWith('antigravity')) return 'antigravity';
  if (executorId.startsWith('grok')) return 'grok';
  return undefined;
}

/**
 * How far Kiki's hooks reach on one engine. `supported`: verified end to end;
 * `untested`: wired but never run against the real engine; `unsupported`: the
 * bridge refuses to start hooks for it.
 */
export type HookSupportLevel = 'supported' | 'untested' | 'unsupported';

/** The moments the bridge hooks per engine, and whether each one delivers text. */
export interface HookMoment {
  readonly event: string;
  /** `inject`: text reaches the engine; `prepare`: Kiki only readies the handoff. */
  readonly effect: 'inject' | 'prepare';
}

export interface HookSupport {
  readonly level: HookSupportLevel;
  readonly harness?: HookHarness;
  readonly moments: readonly HookMoment[];
}

const COMMAND_HOOKS: readonly HookMoment[] = [
  { event: 'SessionStart', effect: 'inject' },
  { event: 'UserPromptSubmit', effect: 'inject' },
  { event: 'PreCompact', effect: 'prepare' },
];

export function hookSupport(executorId: string): HookSupport {
  const harness = hookHarnessOf(executorId);
  switch (harness) {
    case 'claude':
    case 'codex':
      return { level: 'supported', harness, moments: COMMAND_HOOKS };
    case 'grok':
      // Grok's ACP callback exists only on the ACP adapter.
      return executorId === 'grok-acp'
        ? { level: 'supported', harness, moments: [{ event: 'Stop', effect: 'inject' }] }
        : { level: 'unsupported', moments: [] };
    case 'antigravity':
      return { level: 'untested', harness, moments: [{ event: 'PreInvocation', effect: 'inject' }] };
    default:
      return { level: 'unsupported', moments: [] };
  }
}
