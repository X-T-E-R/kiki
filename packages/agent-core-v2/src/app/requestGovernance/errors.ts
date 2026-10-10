import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { isError2 } from '#/_base/errors/errors';

export const RequestGovernanceErrors = {
  codes: {
    REQUEST_LIMIT_REJECTED: 'request.limit_rejected',
    REQUEST_QUEUE_TIMEOUT: 'request.queue_timeout',
    REQUEST_QUEUE_FULL: 'request.queue_full',
    AGENT_ANCESTOR_LIMIT: 'request.agent_ancestor_limit',
  },
  info: {
    'request.agent_ancestor_limit': { title: 'Parent occupies this agent limit', public: true, retryable: false, action: 'Select subagents only, separate main and subagent rules, or increase the matching rule limit.' },
    'request.limit_rejected': { title: 'Local request limit reached', public: true, retryable: false, action: 'Wait for active requests to finish or change the matching concurrency rule.' },
    'request.queue_timeout': { title: 'Local request queue timed out', public: true, retryable: false, action: 'Retry the turn or adjust the local waiting budget.' },
    'request.queue_full': { title: 'Local request queue full', public: true, retryable: false, action: 'Wait for queued requests to drain before retrying.' },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(RequestGovernanceErrors);

export function isRequestGovernanceError(error: unknown): boolean {
  return isError2(error) && Object.values(RequestGovernanceErrors.codes).some((code) => code === error.code);
}
