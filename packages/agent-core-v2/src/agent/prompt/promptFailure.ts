import { Error2, ErrorCodes } from '#/errors';
import type { PromptSnapshot } from './prompt';

export function promptLaunchFailure(prompt: Pick<PromptSnapshot, 'id' | 'state' | 'error'>): Error2 {
  const reason = prompt.error;
  const reasonCode = typeof reason?.details?.['reason_code'] === 'string'
    ? reason.details['reason_code'] : reason?.code ?? `prompt_${prompt.state}_before_launch`;
  const hint = typeof reason?.details?.['hint'] === 'string'
    ? reason.details['hint']
    : reason?.code === ErrorCodes.CONFIG_INVALID || reason?.code === ErrorCodes.REQUEST_INVALID
      ? 'Correct the requested binding or input, then retry.'
      : 'Check the executor installation, credentials, model and permission settings, then retry.';
  const code = reason !== undefined && (reason.code === ErrorCodes.CONFIG_INVALID || reason.code === ErrorCodes.REQUEST_INVALID)
    ? reason.code : ErrorCodes.INTERNAL;
  return new Error2(code,
    `Prompt ${prompt.id} ${prompt.state} before launch [${reasonCode}]: ${reason?.message ?? 'No turn was launched'}. ${hint}`,
    { details: { ...reason?.details, prompt_id: prompt.id, reason_code: reasonCode, hint, error: reason } });
}
