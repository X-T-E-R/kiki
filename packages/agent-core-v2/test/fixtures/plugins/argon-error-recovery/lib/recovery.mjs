const ARGON_MODEL_ALIAS = 'axon-message/gemini-4-argon';

export function recoveryFor(event) {
  if (event.hook_event_name !== 'StopFailure' || event.recoverable !== true || event.recovery_attempts !== 0) return undefined;
  const missingTerminal = event.upstream_error_code === 'antigravity_missing_terminal';
  const argonFailure = event.model_alias === ARGON_MODEL_ALIAS && (
    event.upstream_error_code === 'gateway_stream_terminal_error' ||
    (event.error_code === 'provider.connection_error' && event.error_details?.retry_exhausted === true)
  );
  if (!missingTerminal && !argonFailure) return undefined;
  return { hookSpecificOutput: { recovery: { action: 'continue', userMessage: '继续' } } };
}
