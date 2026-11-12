import { spawn } from 'node:child_process';

import { clipboard } from './clipboard-native';
import { writeClipboardOSC52 } from './clipboard-osc52';

/** Upper bound for any clipboard helper (native call or child process). */
const CLIPBOARD_TEXT_TIMEOUT_MS = 2000;

/** How the text was delivered: a verified local clipboard tool, an
 *  unverified OSC 52 escape emitted to the terminal, or nothing worked. */
export type ClipboardCopyMethod = 'native' | 'osc52';
export type ClipboardCopyResult = ClipboardCopyMethod | 'failed';

/**
 * True inside an SSH session. The clipboard of this machine is then not the
 * user's: writing it would put the text on the remote host, and reading it
 * would paste the remote host's clipboard.
 */
export function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['SSH_CONNECTION'] || env['SSH_TTY'] || env['SSH_CLIENT']);
}

/** Resolves `fallback` when `promise` has not settled within `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Pipes `input` into a clipboard command. Resolves false on spawn failure,
 * non-zero exit, or timeout (the child is killed). stdout/stderr are ignored:
 * `xclip` forks a daemon that keeps inherited pipes open, which would stall
 * a caller waiting for them to close.
 */
function pipeToCommand(command: string, args: readonly string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, CLIPBOARD_TEXT_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    child.stdin?.on('error', () => finish(false));
    child.stdin?.end(input);
  });
}

async function copyWithPlatformCommand(text: string): Promise<boolean> {
  const commands =
    process.platform === 'darwin'
      ? [{ command: 'pbcopy', args: [] as string[] }]
      : process.platform === 'win32'
        ? [{ command: 'clip.exe', args: [] as string[] }]
        : [
            { command: 'wl-copy', args: [] as string[] },
            { command: 'xclip', args: ['-selection', 'clipboard'] },
          ];
  for (const candidate of commands) {
    if (await pipeToCommand(candidate.command, candidate.args, text)) return true;
  }
  return false;
}

/**
 * Copies `text` and reports the channel that carried it. Never throws.
 *
 * Over SSH only OSC 52 is tried: it travels over stdout to the user's own
 * terminal, while the native clipboard here belongs to the remote host.
 * Locally the native clipboard is tried first and OSC 52 is the last resort
 * (headless, or no clipboard tool). OSC 52 delivery cannot be confirmed —
 * terminals without support silently drop it — so callers must not word an
 * `'osc52'` result as a confirmed copy.
 */
export async function copyTextToClipboard(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClipboardCopyResult> {
  if (isRemoteSession(env)) return writeClipboardOSC52(text) ? 'osc52' : 'failed';

  const clipboardModule = clipboard;
  if (clipboardModule?.setText !== undefined) {
    // An async wrapper turns a synchronous throw into a rejection, which
    // withTimeout maps to `false`; `?.()` keeps the method's `this`.
    const attempt = (async () => {
      await clipboardModule.setText?.(text);
      return true;
    })();
    if (await withTimeout(attempt, CLIPBOARD_TEXT_TIMEOUT_MS, false)) return 'native';
  }
  if (await copyWithPlatformCommand(text)) return 'native';
  return writeClipboardOSC52(text) ? 'osc52' : 'failed';
}

/**
 * Reads text from the local clipboard for an explicit paste (Ctrl-V).
 * Undefined when there is none, the read fails or times out, or the session
 * is remote (that clipboard is not the user's; the terminal's own paste is).
 */
export async function readClipboardText(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (isRemoteSession(env)) return undefined;
  const clipboardModule = clipboard;
  if (clipboardModule?.getText === undefined) return undefined;
  const text = await withTimeout<string | undefined>(
    (async () => clipboardModule.getText?.())(),
    CLIPBOARD_TEXT_TIMEOUT_MS,
    undefined,
  );
  return text !== undefined && text.length > 0 ? text : undefined;
}
