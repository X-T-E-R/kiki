import { KIMI_ERROR_INFO, isKimiError } from '@kiki/node-sdk';
import { chalkStderr } from 'chalk';

import { STARTUP_ERROR_COLOR } from '#/constant/startup-error';

export interface StartupErrorFormatOptions {
  readonly errorStyle?: (text: string) => string;
  readonly operation?: string;
}

function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatStartupError(
  error: unknown,
  options: StartupErrorFormatOptions = {},
): string {
  const errorStyle = options.errorStyle ?? chalkStderr.hex(STARTUP_ERROR_COLOR);

  if (!isKimiError(error)) {
    const operation = options.operation ?? 'start shell';
    return `${errorStyle(`error: failed to ${operation}: ${formatUnknownErrorMessage(error)}`)}\n`;
  }

  const info = KIMI_ERROR_INFO[error.code];
  const lines = [
    errorStyle(`error: ${info.title}`),
    '',
    errorStyle('message:'),
    errorStyle(error.message),
  ];

  return `${lines.join('\n')}\n`;
}
