import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const BrowserErrors = {
  codes: {
    BROWSER_INVALID: 'browser.invalid', BROWSER_NOT_FOUND: 'browser.not_found', BROWSER_DISABLED: 'browser.disabled',
    BROWSER_DISCONNECTED: 'browser.disconnected', BROWSER_EXECUTION_FAILED: 'browser.execution_failed',
    BROWSER_BUSY: 'browser.busy', BROWSER_VERSION: 'browser.version', BROWSER_TARGET: 'browser.target',
    BROWSER_REQUIRES_ACTION: 'browser.requires_action', BROWSER_UNSUPPORTED: 'browser.unsupported',
  },
  info: {
    'browser.invalid': { title: 'Invalid browser configuration or request', retryable: false, public: true },
    'browser.not_found': { title: 'Browser connection not found', retryable: false, public: true },
    'browser.disabled': { title: 'Browser connection is disabled', retryable: false, public: true },
    'browser.disconnected': { title: 'Browser connection is disconnected', retryable: false, public: true },
    'browser.execution_failed': { title: 'Browser command failed', retryable: false, public: true },
    'browser.busy': { title: 'Browser connection is busy', retryable: false, public: true },
    'browser.version': { title: 'Unsupported browser driver version', retryable: false, public: true },
    'browser.target': { title: 'Browser target is no longer available', retryable: false, public: true },
    'browser.requires_action': { title: 'Browser setup or approval required', retryable: false, public: true },
    'browser.unsupported': { title: 'Unsupported browser provider or operation', retryable: false, public: true },
  },
} as const satisfies ErrorDomain;
registerErrorDomain(BrowserErrors);
export type BrowserErrorCode = typeof BrowserErrors.codes[keyof typeof BrowserErrors.codes];
export class BrowserError extends Error2 {
  declare readonly code: BrowserErrorCode;
  constructor(code: BrowserErrorCode, message: string, options?: Error2Options) { super(code, message, options); this.name = 'BrowserError'; }
}
