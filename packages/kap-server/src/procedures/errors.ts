import {
  EXTERNAL_INTERACTION_NOT_OWNED_CODE,
  ErrorCodes,
  classifyExternalFailureCode,
  externalFailureDescription,
  isError2,
} from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

export interface ExternalDelegationPublicFailure {
  readonly message: string;
  readonly details?: { readonly failure_code: string };
}

export function externalDelegationFailureCode(error: unknown): string | undefined {
  if (!isError2(error)) return undefined;
  const failureCode = error.details?.['failure_code'];
  if (typeof failureCode === 'string') return failureCode;
  return classifyExternalFailureCode(error.code);
}

export function externalDelegationPublicFailure(error: unknown): ExternalDelegationPublicFailure {
  if (error instanceof z.ZodError) return { message: 'Invalid external delegation request.' };
  if (isError2(error)) {
    const failureCode = error.details?.['failure_code'];
    if (failureCode === EXTERNAL_INTERACTION_NOT_OWNED_CODE) {
      return { message: error.message, details: { failure_code: failureCode } };
    }
    if (error.code === ErrorCodes.REQUEST_INVALID) return { message: error.message };
    const category = classifyExternalFailureCode(error.code);
    if (category !== undefined) {
      return {
        message: externalFailureDescription(category),
        details: { failure_code: category },
      };
    }
  }
  return { message: 'External delegation request failed.' };
}
