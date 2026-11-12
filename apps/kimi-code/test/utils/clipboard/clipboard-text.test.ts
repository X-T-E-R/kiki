import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { buildClipboardOSC52 } from '#/utils/clipboard/clipboard-osc52';
import { copyTextToClipboard } from '#/utils/clipboard/clipboard-text';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-native', () => ({
  clipboard: {
    setText: vi.fn(),
  },
}));

const clipboardMock = clipboard as unknown as { setText: ReturnType<typeof vi.fn> };
const spawnMock = vi.mocked(spawn);

// A child process that exits with `code` as soon as its stdin is closed.
function exitingChild(code: number): ReturnType<typeof spawn> {
  const child = new EventEmitter() as EventEmitter & { stdin: unknown; kill: () => void };
  child.stdin = { on: () => {}, end: () => setImmediate(() => child.emit('exit', code)) };
  child.kill = () => {};
  return child as unknown as ReturnType<typeof spawn>;
}

const LOCAL_ENV = {};

const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

function restoreIsTTY(): void {
  if (originalIsTTYDescriptor !== undefined) {
    Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
  }
}

function stubStdoutTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    writable: true,
    value: isTTY,
  });
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

afterEach(() => {
  restoreIsTTY();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

beforeEach(() => {
  spawnMock.mockImplementation(() => {
    throw new Error('platform clipboard fallback should not run');
  });
});

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    clipboardMock.setText.mockResolvedValue(undefined);

    await expect(copyTextToClipboard('cd "/tmp/proj-b"', LOCAL_ENV)).resolves.toBe('native');
    expect(clipboardMock.setText).toHaveBeenCalledWith('cd "/tmp/proj-b"');
  });

  it('keeps native clipboard method context when copying text', async () => {
    clipboardMock.setText.mockImplementation(function (this: unknown, text: string): void {
      expect(this).toBe(clipboardMock);
      expect(text).toBe('cd "/tmp/proj-b"');
    });

    await expect(copyTextToClipboard('cd "/tmp/proj-b"', LOCAL_ENV)).resolves.toBe('native');
  });

  it('reports failed when every clipboard channel fails', async () => {
    stubStdoutTTY(false);
    clipboardMock.setText = undefined as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockImplementation(() => exitingChild(1));

    await expect(copyTextToClipboard('cd "/tmp/proj-b"', LOCAL_ENV)).resolves.toBe('failed');
  });

  it('sends only OSC 52 over SSH, never the remote host clipboard', async () => {
    stubStdoutTTY(true);
    clipboardMock.setText = vi.fn().mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      copyTextToClipboard('hello', { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22' }),
    ).resolves.toBe('osc52');
    expect(clipboardMock.setText).not.toHaveBeenCalled();
    expect(writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
      `]52;c;${base64('hello')}`,
    );
  });
});

describe('buildClipboardOSC52', () => {
  it('emits a bare OSC 52 sequence outside tmux', () => {
    expect(buildClipboardOSC52('hi', false)).toBe(`\u001B]52;c;${base64('hi')}\u0007`);
  });

  it('wraps the sequence in a tmux passthrough with doubled ESC bytes', () => {
    expect(buildClipboardOSC52('hi', true)).toBe(
      `\u001BPtmux;\u001B\u001B]52;c;${base64('hi')}\u0007\u001B\\`,
    );
  });
});

describe('OSC 52 fallback in copyTextToClipboard', () => {
  it('resolves via OSC 52 when native clipboards fail on a terminal', async () => {
    stubStdoutTTY(true);
    clipboardMock.setText = undefined as unknown as ReturnType<typeof vi.fn>;
    spawnMock.mockImplementation(() => exitingChild(1));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(copyTextToClipboard('hello world', LOCAL_ENV)).resolves.toBe('osc52');

    const written = writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).toContain(`]52;c;${base64('hello world')}`);
  });

  it('does not write escape sequences when stdout is not a terminal', async () => {
    stubStdoutTTY(false);
    clipboardMock.setText = vi.fn().mockResolvedValue(undefined);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await copyTextToClipboard('hello', LOCAL_ENV);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});
