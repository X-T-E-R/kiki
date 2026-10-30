import { parse } from 'smol-toml';

export function recipeOptionOrder(source: string): string[] {
  const order = new Set<string>();
  let cursor = 0;
  const skipString = () => {
    const quote = source[cursor]!;
    const delimiter = source.startsWith(quote.repeat(3), cursor) ? quote.repeat(3) : quote;
    cursor += delimiter.length;
    while (cursor < source.length) {
      if (quote === '"' && source[cursor] === '\\') { cursor += 2; continue; }
      if (source.startsWith(delimiter, cursor)) {
        cursor += delimiter.length;
        if (delimiter.length === 3) while (source[cursor] === quote) cursor++;
        return;
      }
      cursor++;
    }
  };
  const skipSpace = () => {
    while (cursor < source.length) {
      if (/\s/u.test(source[cursor]!)) cursor++;
      else if (source[cursor] === '#') { while (cursor < source.length && source[cursor] !== '\n') cursor++; }
      else break;
    }
  };
  const key = (end: string): string[] => {
    const start = cursor;
    while (cursor < source.length && source[cursor] !== end) {
      if (source[cursor] === '"' || source[cursor] === "'") skipString(); else cursor++;
    }
    let table: unknown = parse(`[${source.slice(start, cursor)}]\n__recipe_order_marker__ = true`);
    const path: string[] = [];
    while (typeof table === 'object' && table !== null) {
      const name = Object.keys(table)[0]!;
      if (name === '__recipe_order_marker__') break;
      path.push(name); table = (table as Record<string, unknown>)[name];
    }
    return path;
  };
  const record = (path: string[]) => { if (path[0] === 'options' && path.length > 1) order.add(path[1]!); };
  const skipValue = () => {
    let depth = 0;
    while (cursor < source.length) {
      const character = source[cursor]!;
      if (character === '"' || character === "'") { skipString(); continue; }
      if (character === '#') { while (cursor < source.length && source[cursor] !== '\n') cursor++; continue; }
      if (depth === 0 && (character === '\n' || character === ',' || character === '}' || character === ']')) return;
      if (character === '[' || character === '{') depth++;
      else if (character === ']' || character === '}') depth--;
      cursor++;
    }
  };
  const value = (path: string[]): void => {
    record(path); skipSpace();
    if (path.length !== 1 || path[0] !== 'options' || source[cursor] !== '{') { skipValue(); return; }
    cursor++; skipSpace();
    while (cursor < source.length && source[cursor] !== '}') {
      const nested = key('='); cursor++; value([...path, ...nested]); skipSpace();
      if (source[cursor] === ',') { cursor++; skipSpace(); }
    }
    cursor++;
  };
  let table: string[] = [];
  skipSpace();
  while (cursor < source.length) {
    if (source[cursor] === '[') {
      cursor++; const array = source[cursor] === '['; if (array) cursor++;
      table = key(']'); cursor += array ? 2 : 1; record(table);
    } else {
      const path = [...table, ...key('=')]; cursor++; value(path);
    }
    skipSpace();
  }
  return [...order];
}
