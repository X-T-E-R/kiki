/**
 * Minimal ANSI/VT escape stripping for the terminal panel's screen-reader
 * mirror. The mirror is a plain-text approximation — it drops terminal
 * control sequences (colors, cursor moves, erases) instead of emulating a
 * screen, so it reads as a linear log. PTY output arrives as CRLF lines; the
 * mirror normalizes to LF and keeps only a trailing window of lines.
 */

const ESC = '\u001B';
const BEL = '\u0007';
const BACKSPACE = '\u0008';

// CSI sequences, OSC (…terminated by BEL or ST), and two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|[()#][0-9A-Za-z]|[@-Z\\\\-_~])`,
  'g',
);
// C0 controls other than backspace, tab, LF, CR (kept for the tail logic),
// plus DEL.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0007\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

export function stripAnsi(chunk: string): string {
  return chunk.replaceAll(ANSI_PATTERN, '').replaceAll(CONTROL_PATTERN, '');
}

/**
 * Append a raw terminal chunk to a plain-text tail and keep at most
 * `maxLines` trailing lines. Line-level approximation only: backspaces erase
 * a character, CRLF becomes LF, and a bare CR restarts the line (the text
 * after the last CR wins). Enough for an aria-live log and for tests
 * asserting that output arrived — xterm remains the real renderer.
 */
export function appendPlainTail(tail: string, chunk: string, maxLines = 40): string {
  let text = tail + stripAnsi(chunk);
  // Backspace erases the preceding character; iterate so runs collapse.
  let previous: string;
  do {
    previous = text;
    text = text.replaceAll(
      new RegExp(`[^\\n${BACKSPACE}]${BACKSPACE}`, 'g'),
      '',
    );
  } while (text !== previous);
  text = text.replaceAll(BACKSPACE, '');
  text = text.replaceAll('\r\n', '\n');
  // A bare CR restarts the line: drop everything before the last CR per line.
  text = text.replaceAll(/[^\n\r]*\r/g, '');
  const lines = text.split('\n');
  return lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
}
