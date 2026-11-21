import { HookDefSchema, type HookDefConfig } from '../configSection';
import { HOOK_EVENT_TYPES } from './types';

export interface ParseClaudeHookGroupsOptions {
  readonly allowedEvents?: ReadonlySet<string>;
  readonly transformCommand?: (command: string) => string;
  readonly checkAborted?: () => void;
}

export interface ParseClaudeHookGroupsResult {
  readonly hooks: HookDefConfig[];
  readonly unsupported: string[];
}

const ALL_HOOK_EVENTS: ReadonlySet<string> = new Set(HOOK_EVENT_TYPES);

export function parseClaudeHookGroups(
  mapping: unknown,
  options: ParseClaudeHookGroupsOptions = {},
): ParseClaudeHookGroupsResult {
  const allowedEvents = options.allowedEvents ?? ALL_HOOK_EVENTS;
  const hooks: HookDefConfig[] = [];
  const unsupported: string[] = [];
  if (typeof mapping !== 'object' || mapping === null || Array.isArray(mapping)) {
    return { hooks, unsupported };
  }
  for (const [event, groups] of Object.entries(mapping)) {
    options.checkAborted?.();
    if (!allowedEvents.has(event) || !Array.isArray(groups)) {
      unsupported.push(`hooks:${event}`);
      continue;
    }
    for (const [index, group] of groups.entries()) {
      options.checkAborted?.();
      if (typeof group !== 'object' || group === null || !Array.isArray((group as Record<string, unknown>)['hooks'])) {
        unsupported.push(`hooks:${event}[${index}]`);
        continue;
      }
      const record = group as { matcher?: unknown; hooks: unknown[] };
      for (const hook of record.hooks) {
        options.checkAborted?.();
        if (typeof hook !== 'object' || hook === null) {
          unsupported.push(`hooks:${event}[${index}]`);
          continue;
        }
        const rawHook = hook as Record<string, unknown>;
        const rawCommand = typeof rawHook['command'] === 'string' ? rawHook['command'] : undefined;
        const command = rawCommand === undefined ? undefined : (options.transformCommand?.(rawCommand) ?? rawCommand);
        const value = HookDefSchema.safeParse({
          event,
          matcher: record.matcher,
          timeout: typeof rawHook['timeout'] === 'number' ? rawHook['timeout'] : undefined,
          command,
        });
        if (rawHook['type'] !== 'command' || !value.success) {
          unsupported.push(`hooks:${event}[${index}]:${String(rawHook['type'])}`);
        } else {
          hooks.push(value.data);
        }
      }
    }
  }
  return { hooks, unsupported };
}
