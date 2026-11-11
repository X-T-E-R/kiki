export const ARGON_MODEL_ALIAS = 'axon-message/gemini-4-argon';

const nativeProviderErrorCodes = new Set([
  'antigravity_missing_terminal',
  'antigravity_empty_response',
  'gateway_stream_terminal_error',
]);

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

export function nativeRecoveryFor(snapshot) {
  const { recoveryStreakCount, maxRecoveryBudget } = snapshot;
  if (snapshot.modelAlias !== ARGON_MODEL_ALIAS || snapshot.protocol !== 'anthropic' ||
      snapshot.errorCode !== 'provider.api_error' || !Number.isSafeInteger(recoveryStreakCount) ||
      !Number.isSafeInteger(maxRecoveryBudget) || recoveryStreakCount < 0 || maxRecoveryBudget < 1 ||
      recoveryStreakCount >= maxRecoveryBudget) return { action: 'pass' };

  const retryableHttpFailure = snapshot.statusCode === 400 || snapshot.statusCode === 500;
  const knownProviderFailure = nativeProviderErrorCodes.has(snapshot.providerErrorCode);
  if (!retryableHttpFailure && !knownProviderFailure) return { action: 'pass' };
  return { action: 'enqueue_recovery_continuation', reminderText: '继续', variant: 'argon_error_recovery' };
}
