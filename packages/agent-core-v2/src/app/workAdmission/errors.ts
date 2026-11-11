import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkAdmissionErrors = {
  codes: { WORK_ADMISSION_FENCED: 'work.admission_fenced' },
  info: {
    'work.admission_fenced': {
      title: 'Waiting for server switch',
      retryable: true,
      public: true,
      action: 'Keep the original request identity and send it after the server switch, or cancel this switch to continue on the current server.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkAdmissionErrors);
