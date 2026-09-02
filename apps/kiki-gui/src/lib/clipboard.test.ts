// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyTextToClipboard } from './clipboard';

function mockExecCommand(result: boolean) {
  const execCommand = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('copyTextToClipboard', () => {
  it('uses the async clipboard API when it succeeds', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const execCommand = mockExecCommand(true);

    await copyTextToClipboard('copied');

    expect(writeText).toHaveBeenCalledWith('copied');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('falls back to execCommand after clipboard denial', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    const execCommand = mockExecCommand(true);

    await copyTextToClipboard('fallback');

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('rejects when execCommand reports failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    mockExecCommand(false);

    await expect(copyTextToClipboard('failed')).rejects.toThrow(
      'Clipboard fallback rejected the copy command.',
    );
    expect(document.querySelector('textarea')).toBeNull();
  });
});
