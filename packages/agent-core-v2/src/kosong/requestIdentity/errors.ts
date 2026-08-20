import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const RequestIdentityErrors = {
  codes: {
    REQUEST_IDENTITY_UNSUPPORTED: 'request_identity.unsupported',
    REQUEST_IDENTITY_CONFLICT: 'request_identity.conflict',
    REQUEST_IDENTITY_INVALID: 'request_identity.invalid',
  },
  info: {
    'request_identity.unsupported': {
      title: 'Request identity unsupported',
      retryable: false,
      public: true,
      action: 'Choose a request identity policy supported by the selected protocol.',
    },
    'request_identity.conflict': {
      title: 'Request identity conflict',
      retryable: false,
      public: true,
      action: 'Remove conflicting legacy fields or custom headers.',
    },
    'request_identity.invalid': {
      title: 'Invalid request identity',
      retryable: false,
      public: true,
      action: 'Correct the request identity policy values.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(RequestIdentityErrors);
