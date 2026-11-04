export function recoveryFor(event) {
  if (event.hook_event_name !== 'StopFailure' || event.recoverable !== true || event.recovery_attempts !== 0) return undefined;
  if (event.upstream_error_code !== 'antigravity_missing_terminal') return undefined;
  return { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };
}
