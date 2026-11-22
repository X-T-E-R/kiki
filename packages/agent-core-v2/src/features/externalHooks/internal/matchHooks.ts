import { camelToSnake } from '#/app/config/toml';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import { runHook } from './runHook';
import {
  compileHookMatcher,
  type HookBlockDecision,
  type HookDef,
  type HookMatcherValue,
  type HookResult,
} from './types';

import type { ExternalHooksRunnerTriggerArgs } from '../app/externalHooksRunner';

const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;

export interface HookRunCallbacks {
  readonly onTriggered?: (event: string, target: string, count: number) => void;
  readonly onResolved?: (
    event: string,
    target: string,
    action: string,
    reason: string | undefined,
    durationMs: number,
  ) => void;
}

export interface IndexedHookDef {
  readonly hook: HookDef;
  readonly matcher?: RegExp;
}

export function indexHooks(hooks: readonly HookDef[]): Map<string, IndexedHookDef[]> {
  const byEvent = new Map<string, IndexedHookDef[]>();
  for (const hook of hooks) {
    const entries = byEvent.get(hook.event) ?? [];
    entries.push({
      hook,
      matcher:
        hook.matcher === undefined || hook.matcher.length === 0
          ? undefined
          : compileHookMatcher(hook.matcher),
    });
    byEvent.set(hook.event, entries);
  }
  return byEvent;
}

export async function runMatchedHooks(
  hostProcess: IHostProcessService,
  byEvent: ReadonlyMap<string, readonly IndexedHookDef[]>,
  event: string,
  args: ExternalHooksRunnerTriggerArgs,
  callbacks: HookRunCallbacks = {},
): Promise<HookResult[]> {
  const matcherValue = matcherValueText(args.matcherValue);
  const matched: HookDef[] = [];
  const seen = new Set<string>();
  for (const indexed of byEvent.get(event) ?? []) {
    if (indexed.matcher !== undefined && !indexed.matcher.test(matcherValue)) continue;
    const { hook } = indexed;
    const key = (hook.cwd ?? '') + '\0' + hook.command;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(hook);
  }
  if (matched.length === 0) return [];

  const directories = args.getDirectories?.();
  const cwd = directories?.cwd ?? args.cwd ?? '';
  const processCwd = directories?.processCwd ?? cwd;

  try {
    callbacks.onTriggered?.(event, matcherValue, matched.length);
  } catch {}

  const inputData = toHookInputData({
    hookEventName: event,
    sessionId: args.sessionId ?? '',
    cwd,
    ...args.inputData,
  });

  const startedAt = Date.now();
  const results = await Promise.all(
    matched.map((hook) =>
      runHook(hostProcess, hook.command, inputData, {
        timeout: hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
        cwd: hook.cwd ?? (processCwd === '' ? undefined : processCwd),
        env: hook.env,
        signal: args.signal,
      }),
    ),
  );

  const decision = blockDecision(event, results);
  try {
    callbacks.onResolved?.(
      event,
      matcherValue,
      decision === undefined ? 'allow' : decision.block ? 'block' : 'allow',
      decision?.reason,
      Date.now() - startedAt,
    );
  } catch {}

  return results;
}

export function isFailOpenBlockEvent(event: string): boolean {
  return event === 'Stop' || event === 'SubagentStop';
}

export function isExplicitHookBlock(result: HookResult): boolean {
  if (result.action !== 'block') return false;
  if (result.timedOut === true) return false;
  return result.exitCode === 2 || (result.exitCode === 0 && result.structuredOutput === true);
}

export function blockDecision(
  event: string,
  results: readonly HookResult[],
): HookBlockDecision | undefined {
  const block = isFailOpenBlockEvent(event)
    ? results.find(isExplicitHookBlock)
    : results.find((result) => result.action === 'block');
  if (block === undefined) return undefined;
  const reason = block.reason?.trim();
  return {
    block: true,
    reason: reason === undefined || reason.length === 0 ? `Blocked by ${event} hook` : reason,
  };
}

function matcherValueText(value: HookMatcherValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return value
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

function toHookInputData(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[camelToSnake(key)] = value;
  }
  return result;
}
