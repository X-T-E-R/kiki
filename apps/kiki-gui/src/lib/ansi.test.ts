import { describe, expect, it } from 'vitest';

import { appendPlainTail, stripAnsi } from './ansi';

const ESC = '\u001B';
const BEL = '\u0007';
const BS = '\u0008';

describe('stripAnsi', () => {
  it('drops CSI color sequences and keeps text', () => {
    expect(stripAnsi(`${ESC}[1;31mhi${ESC}[0m there`)).toBe('hi there');
  });

  it('drops cursor movement and erase sequences', () => {
    expect(stripAnsi(`a${ESC}[2Kb${ESC}[Gc`)).toBe('abc');
  });

  it('drops OSC sequences terminated by BEL', () => {
    expect(stripAnsi(`${ESC}]0;window title${BEL}$ `)).toBe('$ ');
  });
});

describe('appendPlainTail', () => {
  it('normalizes CRLF to LF', () => {
    expect(appendPlainTail('', 'hi\r\nthere\r\n')).toBe('hi\nthere\n');
  });

  it('applies backspaces, including runs', () => {
    expect(appendPlainTail('', `abc${BS}${BS}xy`)).toBe('axy');
  });

  it('a bare carriage return restarts the line', () => {
    expect(appendPlainTail('', '$ echo\r$ ')).toBe('$ ');
  });

  it('keeps only the trailing window of lines', () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\r\n');
    const tail = appendPlainTail('', many, 10);
    expect(tail.split('\n')).toHaveLength(10);
    expect(tail).toContain('line 59');
    expect(tail).not.toContain('line 49');
  });
});
