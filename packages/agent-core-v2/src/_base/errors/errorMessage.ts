import { isCodedError, toErrorPayload } from './serialize';

export function toErrorDisplayMessage(error: unknown): string {
  const { message, details } = toErrorPayload(error);
  const attempts = details?.['retry_attempts'];
  const maxAttempts = details?.['retry_max_attempts'];
  if (details?.['retry_exhausted'] !== true ||
    typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1 ||
    typeof maxAttempts !== 'number' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 ||
    attempts < maxAttempts) return message;
  const summary = `Retry attempts exhausted (${attempts}/${maxAttempts}).`;
  return message.startsWith(summary) ? message : `${summary} ${message}`;
}

export function toErrorMessage(error: unknown, verbose = false): string {
  if (isCodedError(error)) {
    const base = `[${error.code}] ${error.message}`;
    return verbose && error.details ? `${base} ${JSON.stringify(error.details)}` : base;
  }
  if (error instanceof Error) {
    const base = error.message || error.name;
    if (verbose && error.cause !== undefined) {
      return `${base} (caused by: ${toErrorMessage(error.cause)})`;
    }
    return base;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
