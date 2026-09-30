import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const RequestIdentityErrors = {
  codes: {
    REQUEST_IDENTITY_UNSUPPORTED: 'request_identity.unsupported',
    REQUEST_IDENTITY_CONFLICT: 'request_identity.conflict',
    REQUEST_IDENTITY_INVALID: 'request_identity.invalid',
    REQUEST_IDENTITY_NOT_FOUND: 'request_identity.not_found',
    REQUEST_IDENTITY_UPDATE_FAILED: 'request_identity.update_failed',
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
    'request_identity.not_found': {
      title: 'Request identity not found',
      retryable: false,
      public: true,
      action: 'Reload the identity list and pick an existing identity.',
    },
    'request_identity.update_failed': {
      title: 'Request identity update check failed',
      retryable: true,
      public: true,
      action: 'Check the network or the installed CLI, then check again. The current version stays in use.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(RequestIdentityErrors);
