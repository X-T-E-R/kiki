import { isAbsolute, join, parse } from 'pathe';

import picomatch from 'picomatch';

import { canonicalizePath, type PathClass } from './path-access';

export interface PermissionPathMatchOptions {
  readonly cwd?: string;
  readonly pathClass?: PathClass;
  readonly homeDir?: string;
  readonly caseInsensitivePaths?: boolean;
}

interface PathMatchSemantics {
  readonly pathClass: PathClass;
}

export function globMatch(value: string, pattern: string, options?: { nocase?: boolean }): boolean {
  if (picomatch.isMatch(value, pattern, options)) return true;

  const normalizedValue = stripLeadingDotSlash(value);
  const normalizedPattern = stripLeadingDotSlash(pattern);
  if (normalizedValue === value && normalizedPattern === pattern) return false;
  return picomatch.isMatch(normalizedValue, normalizedPattern, options);
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

export function pathGlobMatch(
  value: string,
  pattern: string,
  pathOptions?: PermissionPathMatchOptions,
): boolean {
  const semantics = pathMatchSemantics(value, pattern, pathOptions);
  const nocase = pathOptions?.caseInsensitivePaths ?? true;

  if (globMatch(value, pattern, { nocase })) return true;

  for (const valueVariant of pathVariants(value, semantics, pathOptions)) {
    for (const patternVariant of pathVariants(pattern, semantics, pathOptions)) {
      if (globMatch(valueVariant, patternVariant, { nocase })) return true;
    }
  }
  return false;
}

function pathVariants(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string[] {
  const variants = new Set<string>();
  addPathVariant(variants, value, semantics.pathClass);
  addPathVariant(variants, stripLeadingDotPath(value, semantics.pathClass), semantics.pathClass);

  const canonical = canonicalizePathPattern(value, semantics, pathOptions);
  if (canonical !== undefined) addPathVariant(variants, canonical, semantics.pathClass);
  return Array.from(variants);
}

function canonicalizePathPattern(
  value: string,
  semantics: PathMatchSemantics,
  pathOptions: PermissionPathMatchOptions | undefined,
): string | undefined {
  const expanded = expandUserPath(value, semantics.pathClass, pathOptions?.homeDir);
  const cwd = pathOptions?.cwd ?? defaultCwdForPath(expanded);
  if (cwd === undefined) return undefined;
  try {
    return canonicalizePath(expanded, cwd, semantics.pathClass);
  } catch {
    return undefined;
  }
}

function expandUserPath(
  value: string,
  pathClass: PathClass,
  homeDir: string | undefined,
): string {
  if (homeDir === undefined) return value;
  if (value === '~') return homeDir;
  if (value.startsWith('~/') || (pathClass === 'win32' && value.startsWith('~\\'))) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function defaultCwdForPath(value: string): string | undefined {
  if (!isAbsolute(value)) return undefined;
  return parse(value).root;
}

function pathMatchSemantics(
  value: string,
  pattern: string,
  pathOptions: PermissionPathMatchOptions | undefined,
): PathMatchSemantics {
  const pathClass =
    pathOptions?.pathClass ??
    ([value, pattern].some((candidate) => {
      return (
        /^[A-Za-z]:(?:[\\/]|$)/.test(candidate) ||
        candidate.startsWith('\\\\') ||
        candidate.includes('\\')
      );
    })
      ? 'win32'
      : 'posix');
  return { pathClass };
}

function addPathVariant(variants: Set<string>, value: string, pathClass: PathClass): void {
  variants.add(value);
  if (pathClass === 'win32') variants.add(value.replaceAll('\\', '/'));
}

function stripLeadingDotPath(value: string, pathClass: PathClass): string {
  if (value.startsWith('./')) return value.slice(2);
  if (pathClass === 'win32' && value.startsWith('.\\')) return value.slice(2);
  return value;
}

const GLOB_LITERAL_SPECIAL = /[\\*?[\]{}()!+@|]/g;

export function literalRulePattern(toolName: string, subject: string): string {
  return `${toolName}(${escapeRuleSubjectLiteral(subject)})`;
}

export function escapeRuleSubjectLiteral(subject: string): string {
  return subject.replace(GLOB_LITERAL_SPECIAL, '\\$&');
}

export function matchesGlobRuleSubject(ruleArgs: string, subject: string): boolean {
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) => globMatch(value, pattern));
}

export function matchesStringRuleSubject(ruleArgs: string, subject: string): boolean {
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) => stringWildcardMatch(pattern, value));
}

function stringWildcardMatch(pattern: string, value: string): boolean {
  const patternChars = Array.from(pattern);
  const valueChars = Array.from(value);
  let previous = Array.from({ length: valueChars.length + 1 }, () => false);
  previous[0] = true;
  for (let index = 0; index < patternChars.length; index += 1) {
    const token = patternChars[index]!;
    const current = Array.from({ length: valueChars.length + 1 }, () => false);
    if (token === '*') {
      current[0] = previous[0] === true;
      for (let valueIndex = 1; valueIndex <= valueChars.length; valueIndex += 1) {
        current[valueIndex] = current[valueIndex - 1] === true || previous[valueIndex] === true;
      }
    } else {
      const literal = token === '\\' && (patternChars[index + 1] === '*' || patternChars[index + 1] === '?' || patternChars[index + 1] === '\\')
        ? patternChars[++index]!
        : token;
      for (let valueIndex = 1; valueIndex <= valueChars.length; valueIndex += 1) {
        current[valueIndex] = previous[valueIndex - 1] === true &&
          (token === '?' || literal === valueChars[valueIndex - 1]);
      }
    }
    previous = current;
  }
  return previous[valueChars.length] === true;
}

export function matchesPathRuleSubject(
  ruleArgs: string,
  subject: string,
  options?: PermissionPathMatchOptions,
): boolean {
  return matchRuleSubjects(ruleArgs, [subject], (pattern, value) =>
    pathGlobMatch(value, pattern, options),
  );
}

function matchRuleSubjects(
  ruleArgs: string,
  subjects: readonly string[],
  matchesPositivePattern: (pattern: string, subject: string) => boolean,
): boolean {
  if (ruleArgs.length === 0) return true;
  const negated = ruleArgs.startsWith('!');
  const positivePattern = negated ? ruleArgs.slice(1) : ruleArgs;
  const hit = subjects.some((subject) => matchesPositivePattern(positivePattern, subject));
  return negated ? !hit : hit;
}
