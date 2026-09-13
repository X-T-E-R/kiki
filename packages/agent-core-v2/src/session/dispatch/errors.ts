import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const DispatchErrors = {
  codes: {
    DISPATCH_LIMIT_EXCEEDED: 'dispatch.limit_exceeded',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(DispatchErrors);
