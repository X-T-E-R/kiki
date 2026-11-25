import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addUnexpectedErrorListener,
  onUnexpectedError,
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';

function epipeError(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('unexpectedError', () => {
  afterEach(() => {
    resetUnexpectedErrorHandler();
    vi.restoreAllMocks();
  });

  it('absorbs synchronous EPIPE thrown by console.error in defaultHandler without throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw epipeError();
    });
    const observed: unknown[] = [];
    const dispose = addUnexpectedErrorListener((err) => observed.push(err));
    try {
      const failure = new Error('background failure');
      expect(() => onUnexpectedError(failure)).not.toThrow();
      expect(observed).toEqual([failure]);
    } finally {
      dispose();
    }
  });

  it('absorbs synchronous EPIPE thrown by console.error when a custom handler throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw epipeError();
    });
    setUnexpectedErrorHandler(() => {
      throw new Error('handler crashed');
    });
    const observed: unknown[] = [];
    const dispose = addUnexpectedErrorListener((err) => observed.push(err));
    try {
      const failure = new Error('original failure');
      expect(() => onUnexpectedError(failure)).not.toThrow();
      expect(observed).toEqual([failure]);
    } finally {
      dispose();
    }
  });
});
