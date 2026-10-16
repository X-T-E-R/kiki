import type { WireRecord } from '#/wire/record';

const stringRun = /(?:[^"\\\u0000-\u001f]+|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})){1,256}/y;
const numberToken = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** Validates the whole JSON value without materializing large non-usage bodies. Duplicate keys follow JSON.parse's last-key-wins rule. */
export function parseUsageJson(text: string): WireRecord | undefined {
  if (text.length <= 2048) {
    const raw = JSON.parse(text) as WireRecord;
    if (raw === null) throw new SyntaxError('Invalid usage source JSON');
    return raw.type === 'usage.record' ? raw : undefined;
  }
  let position = 0;
  let type: string | undefined;
  let rootObject = false;
  let rootKey = '';
  const stack: number[] = [];
  const fail = (): never => { throw new SyntaxError('Invalid usage source JSON'); };
  const whitespace = (): void => {
    while (position < text.length) {
      const code = text.charCodeAt(position);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
      position++;
    }
  };
  const string = (): string => {
    const start = position++;
    for (;;) {
      if (text[position] === '"') return text.slice(start, ++position);
      stringRun.lastIndex = position;
      if (!stringRun.test(text)) return fail();
      position = stringRun.lastIndex;
    }
  };
  const value = (captureType: boolean): void => {
    whitespace();
    const token = text[position];
    if (captureType) type = undefined;
    if (token === '"') {
      const encoded = string();
      if (captureType) type = JSON.parse(encoded) as string;
    } else if (token === '{' || token === '[') {
      position++;
      stack.push(token === '{' ? 0 : 5);
    } else if (token === 't' && text.startsWith('true', position)) position += 4;
    else if (token === 'f' && text.startsWith('false', position)) position += 5;
    else if (token === 'n' && text.startsWith('null', position)) position += 4;
    else {
      numberToken.lastIndex = position;
      const number = numberToken.exec(text);
      if (number === null) return fail();
      position = numberToken.lastIndex;
    }
  };
  whitespace();
  rootObject = text[position] === '{';
  value(false);
  while (stack.length > 0) {
    whitespace();
    const top = stack.length - 1;
    const state = stack[top];
    const token = text[position];
    if ((state === 0 && token === '}') || (state === 5 && token === ']')) {
      position++;
      stack.pop();
    } else if (state === 0 || state === 4) {
      if (token !== '"') return fail();
      const key = string();
      if (rootObject && top === 0) rootKey = JSON.parse(key) as string;
      whitespace();
      if (text[position++] !== ':') return fail();
      stack[top] = 3;
      value(rootObject && top === 0 && rootKey === 'type');
    } else if (state === 5 || state === 6) {
      stack[top] = 7;
      value(false);
    } else if (state === 3 || state === 7) {
      if (token === (state === 3 ? '}' : ']')) {
        position++;
        stack.pop();
      } else if (token === ',') {
        position++;
        stack[top] = state === 3 ? 4 : 6;
      } else return fail();
    } else return fail();
  }
  whitespace();
  if (position !== text.length || text.trim() === 'null') return fail();
  return rootObject && type === 'usage.record' ? JSON.parse(text) as WireRecord : undefined;
}
