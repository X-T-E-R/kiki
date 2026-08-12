import { describe, expect, it } from 'vitest';

import { ApiError, isSessionNotFoundMessage } from './client';

describe('isSessionNotFoundMessage', () => {
  it('matches the wire envelope message for a missing session', () => {
    const error = new ApiError({ code: 40401, msg: 'session.not_found', data: null });
    expect(isSessionNotFoundMessage(error.message)).toBe(true);
  });

  it('matches on the numeric code even when the msg text differs', () => {
    expect(isSessionNotFoundMessage('Could not load session (code 40401)')).toBe(true);
  });

  it('rejects other load failures', () => {
    expect(isSessionNotFoundMessage('prompt.not_found (code 40402)')).toBe(false);
    expect(isSessionNotFoundMessage('request timed out (code -2)')).toBe(false);
    expect(isSessionNotFoundMessage('Could not load session')).toBe(false);
  });
});
