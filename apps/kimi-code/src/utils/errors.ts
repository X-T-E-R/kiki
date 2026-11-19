export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortMessage(message: string): boolean {
  return message === 'Aborted' || message.endsWith(': Aborted');
}

export function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError' || isAbortMessage(error.message);
  }
  if (error instanceof Error) {
    return error.name === 'AbortError' || isAbortMessage(error.message);
  }
  if (isRecord(error)) {
    const name = error['name'];
    if (name === 'AbortError') return true;
    const message = error['message'];
    return typeof message === 'string' && isAbortMessage(message);
  }
  return isAbortMessage(String(error));
}
