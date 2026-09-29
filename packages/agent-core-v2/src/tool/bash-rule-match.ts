import { parse, type SyntaxNode } from '@kiki/tree-sitter-bash';

export type BashRuleMatchMode = 'all' | 'any';

export interface BashCommandSegment {
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface BashCommandAnalysis {
  readonly reliable: boolean;
  readonly segments: readonly BashCommandSegment[];
}

interface BashPatternToken {
  readonly kind: 'literal' | 'star' | 'question';
  readonly value?: string;
}

const BASH_PARSE_OPTIONS = {
  timeoutMs: 25,
  maxNodes: 10_000,
} as const;

export function analyzeBashCommand(command: string): BashCommandAnalysis {
  const result = parse(command, BASH_PARSE_OPTIONS);
  if (!result.ok || result.hasError) return { reliable: false, segments: [] };

  const segments: BashCommandSegment[] = [];
  collectCommandSegments(result.rootNode, segments);
  if (segments.length === 0 && command.trim().length > 0) {
    const startIndex = command.search(/\S/u);
    segments.push({ text: command.trim(), startIndex, endIndex: command.trimEnd().length });
  }
  return { reliable: true, segments };
}

export function matchesBashRuleSubject(
  ruleArgs: string,
  subject: string,
  mode: BashRuleMatchMode = 'all',
  analysis: BashCommandAnalysis = analyzeBashCommand(subject),
): boolean {
  const rawMatch = matchBashPattern(ruleArgs, subject);
  if (!analysis.reliable) return mode === 'all' ? false : rawMatch;

  if (mode === 'all') {
    return analysis.segments.length > 0 && analysis.segments.every((segment) =>
      matchBashPattern(ruleArgs, segment.text),
    );
  }
  return rawMatch || analysis.segments.some((segment) => matchBashPattern(ruleArgs, segment.text));
}

export function matchBashPattern(pattern: string, value: string): boolean {
  const tokens = tokenizeBashPattern(pattern);
  const valueChars = Array.from(value);
  let previous = Array.from({ length: valueChars.length + 1 }, () => false);
  previous[0] = true;

  for (const token of tokens) {
    const current = Array.from({ length: valueChars.length + 1 }, () => false);
    if (token.kind === 'star') {
      current[0] = previous[0] === true;
      for (let index = 1; index <= valueChars.length; index += 1) {
        current[index] = current[index - 1] === true || previous[index] === true;
      }
    } else {
      for (let index = 1; index <= valueChars.length; index += 1) {
        current[index] = previous[index - 1] === true &&
          (token.kind === 'question' || token.value === valueChars[index - 1]);
      }
    }
    previous = current;
  }

  return previous[valueChars.length] === true;
}

function tokenizeBashPattern(pattern: string): BashPatternToken[] {
  const tokens: BashPatternToken[] = [];
  const chars = Array.from(pattern);
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === '\\') {
      const next = chars[index + 1];
      if (next === '*' || next === '?' || next === '\\') {
        tokens.push({ kind: 'literal', value: next });
        index += 1;
      } else {
        tokens.push({ kind: 'literal', value: char });
      }
    } else if (char === '*') {
      tokens.push({ kind: 'star' });
    } else if (char === '?') {
      tokens.push({ kind: 'question' });
    } else {
      tokens.push({ kind: 'literal', value: char });
    }
  }
  return tokens;
}

function collectCommandSegments(node: SyntaxNode, segments: BashCommandSegment[]): void {
  if (node.type === 'command' || node.type === 'subshell') {
    const text = node.text.trim();
    if (text.length > 0) {
      const leading = node.text.search(/\S/u);
      segments.push({
        text,
        startIndex: node.startIndex + leading,
        endIndex: node.endIndex,
      });
    }
  }
  for (const child of node.children) collectCommandSegments(child, segments);
}
