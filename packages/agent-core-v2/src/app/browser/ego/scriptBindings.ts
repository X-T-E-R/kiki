export interface EgoScriptBindingAnalysis {
  readonly usesFreeTask: boolean;
  readonly usesFreePage: boolean;
  readonly usesFreeEval: boolean;
  readonly declaresTopLevelTask: boolean;
  readonly declaresTopLevelPage: boolean;
}

interface JsToken {
  readonly kind: 'id' | 'kw' | 'punc' | 'lit';
  readonly text: string;
  readonly lineBreakBefore: boolean;
}

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const REGEX_KEYWORDS = new Set([
  'await', 'case', 'default', 'delete', 'do', 'else', 'export', 'in', 'instanceof',
  'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield',
]);

const CONTINUATION_PUNCTS = new Set([
  '.', '?.', '(', '[', '+', '-', '*', '/', '%', '**', '&&', '||', '??', '?', ':', ',',
  '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '=>',
]);

const MULTI_PUNCTS = [
  '>>>=', '===', '!==', '>>>', '<<=', '>>=', '**=', '&&=', '||=', '??=', '...',
  '?.', '=>', '++', '--', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
];

function isIdStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95 || code > 127;
}

function isIdPart(code: number): boolean {
  return isIdStart(code) || (code >= 48 && code <= 57);
}

function canStartRegex(prev: JsToken | undefined, closedCondParen: boolean): boolean {
  if (prev === undefined) return true;
  if (prev.kind === 'kw') return REGEX_KEYWORDS.has(prev.text);
  if (prev.kind !== 'punc') return false;
  if (prev.text === ')') return closedCondParen;
  return prev.text !== ']' && prev.text !== '++' && prev.text !== '--';
}

function scanQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === '\\') {
      index += 2;
      continue;
    }
    index += 1;
    if (ch === quote) break;
  }
  return index;
}

function scanTemplateChunk(source: string, start: number): { readonly end: number; readonly interpolated: boolean } {
  let index = start;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '`') return { end: index + 1, interpolated: false };
    if (ch === '$' && source[index + 1] === '{') return { end: index + 2, interpolated: true };
    index += 1;
  }
  return { end: index, interpolated: false };
}

function scanRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '\n' || ch === '\r') break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      index += 1;
      while (index < source.length && isIdPart(source.charCodeAt(index))) index += 1;
      break;
    }
    index += 1;
  }
  return index;
}

function tokenizeJs(source: string): readonly JsToken[] {
  const tokens: JsToken[] = [];
  const parenCondStack: boolean[] = [];
  const braceStack: ('block' | 'template')[] = [];
  let index = source.startsWith('#!') ? (source.indexOf('\n') === -1 ? source.length : source.indexOf('\n')) : 0;
  let lineBreakBefore = false;
  let closedCondParen = false;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v' || ch === '\uFEFF') {
      index += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      lineBreakBefore = true;
      index += 1;
      continue;
    }
    if (ch === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      const end = close === -1 ? source.length : close + 2;
      if (source.slice(index + 2, end).includes('\n') || source.slice(index + 2, end).includes('\r')) lineBreakBefore = true;
      index = end;
      continue;
    }
    const prev = tokens.at(-1);
    const emit = (kind: JsToken['kind'], text: string): void => {
      tokens.push({ kind, text, lineBreakBefore });
      lineBreakBefore = false;
      closedCondParen = false;
    };
    if (ch === '\'' || ch === '"') {
      index = scanQuoted(source, index, ch);
      emit('lit', '');
      continue;
    }
    if (ch === '`') {
      const chunk = scanTemplateChunk(source, index + 1);
      index = chunk.end;
      if (chunk.interpolated) {
        braceStack.push('template');
        emit('punc', '{');
      } else emit('lit', '');
      continue;
    }
    if (ch === '}' && braceStack.at(-1) === 'template') {
      braceStack.pop();
      emit('punc', '}');
      const chunk = scanTemplateChunk(source, index + 1);
      index = chunk.end;
      if (chunk.interpolated) {
        braceStack.push('template');
        emit('punc', '{');
      } else emit('lit', '');
      continue;
    }
    if (ch === '/' && canStartRegex(prev, closedCondParen)) {
      index = scanRegex(source, index);
      emit('lit', '');
      continue;
    }
    const code = source.charCodeAt(index);
    if ((code >= 48 && code <= 57) || (ch === '.' && index + 1 < source.length && source.charCodeAt(index + 1) >= 48 && source.charCodeAt(index + 1) <= 57)) {
      index += 1;
      while (index < source.length && (isIdPart(source.charCodeAt(index)) || source[index] === '.')) {
        if ((source[index] === 'e' || source[index] === 'E') && (source[index + 1] === '+' || source[index + 1] === '-')) index += 2;
        else index += 1;
      }
      emit('lit', '');
      continue;
    }
    if (ch === '#' && index + 1 < source.length && isIdStart(source.charCodeAt(index + 1))) {
      index += 2;
      while (index < source.length && isIdPart(source.charCodeAt(index))) index += 1;
      emit('lit', '');
      continue;
    }
    if (isIdStart(code)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdPart(source.charCodeAt(index))) index += 1;
      const word = source.slice(start, index);
      emit(JS_KEYWORDS.has(word) ? 'kw' : 'id', word);
      continue;
    }
    if (ch === '{') braceStack.push('block');
    else if (ch === '}') braceStack.pop();
    else if (ch === '(') parenCondStack.push(prev?.kind === 'kw' && (prev.text === 'if' || prev.text === 'while' || prev.text === 'for' || prev.text === 'with'));
    else if (ch === ')') {
      const cond = parenCondStack.pop() === true;
      emit('punc', ')');
      closedCondParen = cond;
      index += 1;
      continue;
    }
    const matched = MULTI_PUNCTS.find((item) => source.startsWith(item, index) && !(item === '?.' && index + 2 < source.length && source.charCodeAt(index + 2) >= 48 && source.charCodeAt(index + 2) <= 57));
    if (matched !== undefined) {
      index += matched.length;
      emit('punc', matched);
      continue;
    }
    index += 1;
    emit('punc', ch);
  }
  return tokens;
}

function pairBrackets(tokens: readonly JsToken[]): ReadonlyMap<number, number> {
  const pairs = new Map<number, number>();
  const stack: { readonly index: number; readonly close: string }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'punc') continue;
    if (tok.text === '(') stack.push({ index: i, close: ')' });
    else if (tok.text === '[') stack.push({ index: i, close: ']' });
    else if (tok.text === '{') stack.push({ index: i, close: '}' });
    else if (tok.text === ')' || tok.text === ']' || tok.text === '}') {
      const top = stack.at(-1);
      if (top?.close === tok.text) {
        stack.pop();
        pairs.set(top.index, i);
      }
    }
  }
  return pairs;
}

function skipBalancedExpression(tokens: readonly JsToken[], start: number, limit: number, pairs: ReadonlyMap<number, number>): number {
  let index = start;
  while (index < limit) {
    const tok = tokens[index]!;
    if (tok.kind === 'punc' && tok.text === ',') return index;
    if (tok.kind === 'punc' && (tok.text === '(' || tok.text === '[' || tok.text === '{')) {
      const close = pairs.get(index);
      index = close === undefined ? index + 1 : close + 1;
      continue;
    }
    index += 1;
  }
  return index;
}

function collectPattern(
  tokens: readonly JsToken[],
  start: number,
  end: number,
  pairs: ReadonlyMap<number, number>,
  target: Set<string>,
  declSites: Set<number>,
): void {
  let index = start;
  while (index < end) {
    const tok = tokens[index]!;
    if (tok.kind === 'punc' && tok.text === '=') {
      index = skipBalancedExpression(tokens, index + 1, end, pairs);
      continue;
    }
    if (tok.kind === 'punc' && tok.text === '[') {
      const close = pairs.get(index);
      if (close !== undefined) {
        if (tokens[close + 1]?.kind === 'punc' && tokens[close + 1]?.text === ':') {
          index = close + 2;
          continue;
        }
        collectPattern(tokens, index + 1, close, pairs, target, declSites);
        index = close + 1;
        continue;
      }
    }
    if (tok.kind === 'punc' && tok.text === '{') {
      const close = pairs.get(index);
      if (close !== undefined) {
        collectObjectPattern(tokens, index + 1, close, pairs, target, declSites);
        index = close + 1;
        continue;
      }
    }
    if (tok.kind === 'id') {
      target.add(tok.text);
      declSites.add(index);
    }
    index += 1;
  }
}

function collectObjectPattern(
  tokens: readonly JsToken[],
  start: number,
  end: number,
  pairs: ReadonlyMap<number, number>,
  target: Set<string>,
  declSites: Set<number>,
): void {
  let index = start;
  while (index < end) {
    const itemEnd = skipBalancedExpression(tokens, index, end, pairs);
    const first = tokens[index];
    if (first?.kind === 'punc' && first.text === '...') {
      collectPattern(tokens, index + 1, itemEnd, pairs, target, declSites);
    } else if (first?.kind === 'punc' && first.text === '[') {
      const close = pairs.get(index);
      if (close !== undefined && tokens[close + 1]?.text === ':') {
        collectPattern(tokens, close + 2, itemEnd, pairs, target, declSites);
      }
    } else if ((first?.kind === 'id' || first?.kind === 'kw' || first?.kind === 'lit') && tokens[index + 1]?.text === ':') {
      collectPattern(tokens, index + 2, itemEnd, pairs, target, declSites);
    } else {
      collectPattern(tokens, index, itemEnd, pairs, target, declSites);
    }
    index = itemEnd + 1;
  }
}

function canEndStatementBeforeLineBreak(prev: JsToken | undefined, next: JsToken): boolean {
  if (prev === undefined) return false;
  const prevEnds = prev.kind === 'id' || prev.kind === 'lit'
    || (prev.kind === 'kw' && (prev.text === 'true' || prev.text === 'false' || prev.text === 'null' || prev.text === 'this'))
    || (prev.kind === 'punc' && (prev.text === ')' || prev.text === ']' || prev.text === '}' || prev.text === '++' || prev.text === '--'));
  if (!prevEnds) return false;
  if (next.kind === 'kw') return next.text !== 'in' && next.text !== 'instanceof';
  if (next.kind === 'punc') return !CONTINUATION_PUNCTS.has(next.text);
  return true;
}

function scanVarList(
  tokens: readonly JsToken[],
  start: number,
  limit: number,
  pairs: ReadonlyMap<number, number>,
  target: Set<string>,
  declSites: Set<number>,
  stopOnOfIn: boolean,
): number {
  let index = start;
  while (index < limit) {
    const first = tokens[index];
    if (first === undefined) break;
    if (first.kind === 'id') {
      target.add(first.text);
      declSites.add(index);
      index += 1;
    } else if (first.kind === 'punc' && (first.text === '{' || first.text === '[')) {
      const close = pairs.get(index);
      if (close === undefined) break;
      if (first.text === '{') collectObjectPattern(tokens, index + 1, close, pairs, target, declSites);
      else collectPattern(tokens, index + 1, close, pairs, target, declSites);
      index = close + 1;
    } else break;
    if (index >= limit) break;
    const sep = tokens[index]!;
    if (stopOnOfIn && sep.kind === 'kw' && (sep.text === 'of' || sep.text === 'in')) return index;
    if (sep.kind === 'punc' && sep.text === ',') {
      index += 1;
      continue;
    }
    if (sep.kind === 'punc' && sep.text === ';') return index + 1;
    if (sep.kind !== 'punc' || sep.text !== '=') return index;
    index += 1;
    while (index < limit) {
      const cur = tokens[index]!;
      if (cur.lineBreakBefore && canEndStatementBeforeLineBreak(tokens[index - 1], cur)) return index;
      if (cur.kind === 'punc' && (cur.text === '(' || cur.text === '[' || cur.text === '{')) {
        const close = pairs.get(index);
        index = close === undefined ? index + 1 : close + 1;
        continue;
      }
      if (cur.kind === 'punc' && cur.text === ';') return index + 1;
      if (cur.kind === 'punc' && cur.text === ',') {
        index += 1;
        break;
      }
      if (cur.kind === 'punc' && (cur.text === ')' || cur.text === ']' || cur.text === '}')) return index;
      index += 1;
    }
  }
  return index;
}

function arrowEnd(tokens: readonly JsToken[], start: number, limit: number, pairs: ReadonlyMap<number, number>): number {
  if (tokens[start]?.kind === 'punc' && tokens[start]?.text === '{') {
    const close = pairs.get(start);
    return close === undefined ? limit : close + 1;
  }
  let index = start;
  while (index < limit) {
    const tok = tokens[index]!;
    if (tok.lineBreakBefore && canEndStatementBeforeLineBreak(tokens[index - 1], tok)) return index;
    if (tok.kind === 'punc' && (tok.text === '(' || tok.text === '[' || tok.text === '{')) {
      const close = pairs.get(index);
      index = close === undefined ? index + 1 : close + 1;
      continue;
    }
    if (tok.kind === 'punc' && (tok.text === ',' || tok.text === ';' || tok.text === ')' || tok.text === ']' || tok.text === '}')) return index;
    index += 1;
  }
  return index;
}

function statementEnd(tokens: readonly JsToken[], start: number, limit: number, pairs: ReadonlyMap<number, number>): number {
  if (tokens[start]?.kind === 'punc' && tokens[start]?.text === '{') {
    const close = pairs.get(start);
    return close === undefined ? limit : close + 1;
  }
  return arrowEnd(tokens, start, limit, pairs);
}

function isPropertyKeyOrLabel(tokens: readonly JsToken[], index: number): boolean {
  if (tokens[index + 1]?.kind !== 'punc' || tokens[index + 1]?.text !== ':') return false;
  const prev = tokens[index - 1];
  if (prev === undefined) return true;
  return prev.kind === 'punc' && (prev.text === '{' || prev.text === ',' || prev.text === ';' || prev.text === '}' || prev.text === ')');
}

export function analyzeEgoScriptBindings(source: string): EgoScriptBindingAnalysis {
  const tokens = tokenizeJs(source);
  const pairs = pairBrackets(tokens);
  const declSites = new Set<number>();
  const topScope = new Set<string>();
  const scopedRanges: { readonly start: number; readonly end: number; readonly names: Set<string> }[] = [
    { start: 0, end: tokens.length, names: topScope },
  ];
  const scopeStack: Set<string>[] = [topScope];
  const fnScopeStack: Set<string>[] = [topScope];
  const seededScopes = new Map<number, Set<string>>();

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'punc' && tok.text === '{') {
      const close = pairs.get(i) ?? tokens.length;
      const seeded = seededScopes.get(i) ?? new Set<string>();
      scopedRanges.push({ start: i, end: close + 1, names: seeded });
      scopeStack.push(seeded);
      if (seededScopes.has(i)) fnScopeStack.push(seeded);
      continue;
    }
    if (tok.kind === 'punc' && tok.text === '}') {
      const popped = scopeStack.length > 1 ? scopeStack.pop() : undefined;
      if (popped !== undefined && fnScopeStack.at(-1) === popped && fnScopeStack.length > 1) fnScopeStack.pop();
      continue;
    }
    if (tok.kind === 'kw' && tok.text === 'import' && tokens[i + 1]?.text !== '(') {
      let k = i + 1;
      while (k < tokens.length && !(tokens[k]!.kind === 'punc' && tokens[k]!.text === ';')) {
        if (tokens[k]!.kind === 'id' && tokens[k]!.text === 'from') break;
        if (tokens[k]!.kind === 'punc' && tokens[k]!.text === '{') {
          const close = pairs.get(k) ?? tokens.length;
          let m = k + 1;
          while (m < close) {
            if ((tokens[m]!.kind === 'id' || tokens[m]!.kind === 'kw') && tokens[m + 1]?.text === 'as' && tokens[m + 2]?.kind === 'id') {
              topScope.add(tokens[m + 2]!.text);
              declSites.add(m + 2);
              m += 3;
            } else {
              if (tokens[m]!.kind === 'id') {
                topScope.add(tokens[m]!.text);
                declSites.add(m);
              }
              m += 1;
            }
          }
          k = close + 1;
          continue;
        }
        if (tokens[k]!.kind === 'punc' && tokens[k]!.text === '*' && tokens[k + 1]?.text === 'as' && tokens[k + 2]?.kind === 'id') {
          topScope.add(tokens[k + 2]!.text);
          declSites.add(k + 2);
          k += 3;
          continue;
        }
        if (tokens[k]!.kind === 'id') {
          topScope.add(tokens[k]!.text);
          declSites.add(k);
        }
        k += 1;
      }
      continue;
    }
    if (tok.kind === 'kw' && (tok.text === 'const' || tok.text === 'let' || tok.text === 'var')) {
      const target = tok.text === 'var' ? fnScopeStack.at(-1)! : scopeStack.at(-1)!;
      scanVarList(tokens, i + 1, tokens.length, pairs, target, declSites, false);
      continue;
    }
    if (tok.kind === 'kw' && tok.text === 'for' && tokens[i + 1]?.text === '(') {
      const open = i + 1;
      const close = pairs.get(open);
      const declKw = tokens[open + 1];
      if (close !== undefined && declKw?.kind === 'kw' && (declKw.text === 'const' || declKw.text === 'let' || declKw.text === 'var')) {
        const names = declKw.text === 'var' ? fnScopeStack.at(-1)! : new Set<string>();
        scanVarList(tokens, open + 2, close, pairs, names, declSites, true);
        if (declKw.text !== 'var') {
          const end = statementEnd(tokens, close + 1, tokens.length, pairs);
          scopedRanges.push({ start: open, end, names });
        }
      }
      continue;
    }
    if (tok.kind === 'kw' && tok.text === 'function') {
      let cursor = i + 1;
      if (tokens[cursor]?.text === '*') cursor += 1;
      const fnNames = new Set<string>();
      if (tokens[cursor]?.kind === 'id') {
        const name = tokens[cursor]!.text;
        const prev = tokens[i - 1] ?? (tokens[i - 1]?.text === 'async' ? tokens[i - 2] : undefined);
        const isExpr = prev?.kind === 'punc' && (prev.text === '=' || prev.text === '(' || prev.text === '[' || prev.text === ',' || prev.text === ':' || prev.text === '?')
          || (prev?.kind === 'kw' && prev.text === 'return');
        if (!isExpr) scopeStack.at(-1)!.add(name);
        fnNames.add(name);
        declSites.add(cursor);
        cursor += 1;
      }
      if (tokens[cursor]?.text === '(') {
        const closeParen = pairs.get(cursor);
        if (closeParen !== undefined) {
          collectPattern(tokens, cursor + 1, closeParen, pairs, fnNames, declSites);
          scopedRanges.push({ start: cursor, end: closeParen + 1, names: fnNames });
          if (tokens[closeParen + 1]?.text === '{') seededScopes.set(closeParen + 1, fnNames);
        }
      }
      continue;
    }
    if (tok.kind === 'kw' && tok.text === 'class' && tokens[i + 1]?.kind === 'id') {
      scopeStack.at(-1)!.add(tokens[i + 1]!.text);
      declSites.add(i + 1);
      continue;
    }
    if (tok.kind === 'kw' && tok.text === 'catch' && tokens[i + 1]?.text === '(') {
      const closeParen = pairs.get(i + 1);
      if (closeParen !== undefined && tokens[closeParen + 1]?.text === '{') {
        const catchNames = new Set<string>();
        collectPattern(tokens, i + 2, closeParen, pairs, catchNames, declSites);
        seededScopes.set(closeParen + 1, catchNames);
      }
      continue;
    }
    if (tok.kind === 'punc' && tok.text === '(') {
      const closeParen = pairs.get(i);
      if (closeParen !== undefined && tokens[closeParen + 1]?.text === '=>') {
        const arrowNames = new Set<string>();
        collectPattern(tokens, i + 1, closeParen, pairs, arrowNames, declSites);
        const end = arrowEnd(tokens, closeParen + 2, tokens.length, pairs);
        scopedRanges.push({ start: i, end, names: arrowNames });
        if (tokens[closeParen + 2]?.text === '{') seededScopes.set(closeParen + 2, arrowNames);
      }
      continue;
    }
    if (tok.kind === 'id' && tokens[i + 1]?.text === '=>') {
      const arrowNames = new Set<string>([tok.text]);
      declSites.add(i);
      const end = arrowEnd(tokens, i + 2, tokens.length, pairs);
      scopedRanges.push({ start: i, end, names: arrowNames });
      if (tokens[i + 2]?.text === '{') seededScopes.set(i + 2, arrowNames);
    }
  }

  let usesFreeTask = false;
  let usesFreePage = false;
  let usesFreeEval = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'id') continue;
    if (tok.text !== 'task' && tok.text !== 'page' && tok.text !== 'eval') continue;
    if (declSites.has(i)) continue;
    const prev = tokens[i - 1];
    if (prev?.kind === 'punc' && (prev.text === '.' || prev.text === '?.')) continue;
    if (isPropertyKeyOrLabel(tokens, i)) continue;
    const bound = scopedRanges.some((range) => i >= range.start && i < range.end && range.names.has(tok.text));
    if (bound) continue;
    if (tok.text === 'task') usesFreeTask = true;
    else if (tok.text === 'page') usesFreePage = true;
    else usesFreeEval = true;
  }

  return {
    usesFreeTask,
    usesFreePage,
    usesFreeEval,
    declaresTopLevelTask: topScope.has('task'),
    declaresTopLevelPage: topScope.has('page'),
  };
}
