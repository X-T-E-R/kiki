import { ErrorCode } from '@kiki/protocol';

/** Typed application error for Portable Space and Subscription Center routes. */
export class PortableSpaceError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, httpStatus: number, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PortableSpaceError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function portableNotFound(message = 'Portable Space endpoint or source not found'): PortableSpaceError {
  return new PortableSpaceError(ErrorCode.PORTABLE_NOT_FOUND, 404, message);
}

export function portableUnlockRequired(message = 'Encrypted Portable Space requires a passphrase or key to unlock'): PortableSpaceError {
  return new PortableSpaceError(ErrorCode.PORTABLE_UNLOCK_REQUIRED, 400, message);
}

export function portablePreviewStale(message = 'Portable Space target or subscription state changed; preview again'): PortableSpaceError {
  return new PortableSpaceError(ErrorCode.PORTABLE_PREVIEW_STALE, 409, message);
}

export function portablePreviewExpired(message = 'Portable Space preview snapshot expired or was already consumed'): PortableSpaceError {
  return new PortableSpaceError(ErrorCode.PORTABLE_PREVIEW_EXPIRED, 410, message);
}

export function portableValidationError(message: string): PortableSpaceError {
  return new PortableSpaceError(ErrorCode.VALIDATION_FAILED, 400, message);
}
