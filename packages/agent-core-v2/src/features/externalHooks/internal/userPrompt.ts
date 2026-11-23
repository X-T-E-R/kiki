import { isEffectiveHookBlock, type HookResult } from './types';

export function renderHookResult(event: string, message: string): string {
  return `<hook_result hook_event="${event}">\n${message}\n</hook_result>`;
}

export interface RenderedHookResult {
  readonly event: string;
  readonly message: string;
  readonly text: string;
}

export function renderHookContextResult(
  event: string,
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  const messages =
    results
      ?.filter((result) => result.action !== 'block')
      ?.map(extractHookContextMessage)
      .filter(isNonEmptyString) ??
    [];
  if (messages.length === 0) return undefined;
  const displayMessage = messages.join('\n\n');
  return {
    event,
    message: displayMessage,
    text: messages.map((message) => renderHookResult(event, message)).join('\n'),
  };
}

export function renderUserPromptHookResult(
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  return renderHookContextResult('UserPromptSubmit', results);
}

export function renderUserPromptHookBlockResult(
  results: readonly HookResult[] | undefined,
): RenderedHookResult | undefined {
  const block = results?.find(isEffectiveHookBlock);
  if (block === undefined) return undefined;
  const message = block.message?.trim();
  if (message !== undefined && message.length > 0) {
    return {
      event: 'UserPromptSubmit',
      message,
      text: renderHookResult('UserPromptSubmit', message),
    };
  }
  const result = userPromptBlockFallback(block);
  return {
    event: 'UserPromptSubmit',
    message: result,
    text: renderHookResult('UserPromptSubmit', result),
  };
}

function userPromptBlockFallback(block: HookResult): string {
  const reason = block.reason?.trim();
  if (reason !== undefined && reason.length > 0) return reason;
  if (block.timedOut === true) return 'Blocked by UserPromptSubmit hook (timed out)';
  if (block.exitCode !== undefined && block.exitCode !== 0) {
    return `Blocked by UserPromptSubmit hook (exit code ${block.exitCode})`;
  }
  return 'Blocked by UserPromptSubmit hook';
}

function extractHookContextMessage(result: HookResult): string | undefined {
  if (result.timedOut === true || (result.exitCode !== undefined && result.exitCode !== 0)) {
    return undefined;
  }
  const message = result.message?.trim();
  if (message !== undefined && message.length > 0) return message;
  if (result.structuredOutput === true) return undefined;
  const stdout = result.stdout?.trim();
  return stdout === undefined || stdout.length === 0 ? undefined : stdout;
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
