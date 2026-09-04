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

export interface ExternalDelegationLogFailure {
  readonly failure_code?: string;
  readonly error_code?: string;
  readonly error_class: 'validation_error' | 'coded_error' | 'internal_error' | 'non_error';
}

export function externalDelegationLogFailure(error: unknown): ExternalDelegationLogFailure {
  const classified = isError2(error) ? classifyExternalFailureCode(error.code) : undefined;
  const failureCode = isError2(error) && error.details?.['failure_code'] === EXTERNAL_INTERACTION_NOT_OWNED_CODE
    ? EXTERNAL_INTERACTION_NOT_OWNED_CODE
    : classified;
  return {
    failure_code: failureCode,
    error_code: isError2(error) ? error.code : undefined,
    error_class: error instanceof z.ZodError
      ? 'validation_error'
      : isError2(error)
        ? 'coded_error'
        : error instanceof Error
          ? 'internal_error'
          : 'non_error',
  };
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
