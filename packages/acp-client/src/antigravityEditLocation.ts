const EDIT_DIFF_BUDGET = 1_000;
const EDIT_TEXT_BUDGET = 256 * 1024;
const CONTEXT_LINES = 3;

export const ANTIGRAVITY_PRE_EDIT_FILE_LIMIT = 1024 * 1024;
export const ANTIGRAVITY_EDIT_DIFF_OMITTED = Symbol('AntigravityEditDiffOmitted');

const SNIPPET_LABEL = ' snippet, line unknown';

interface ReplacementChunk {
  readonly TargetContent: string;
  readonly ReplacementContent: string;
  readonly StartLine?: number;
  readonly EndLine?: number;
}

interface UnifiedHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

const PASCAL_KEYS: Readonly<Record<string, string>> = {
  replacement_chunks: 'ReplacementChunks',
  target_content: 'TargetContent',
  replacement_content: 'ReplacementContent',
  start_line: 'StartLine',
  end_line: 'EndLine',
};

export function isAntigravitySnippetPatch(patch: string): boolean {
  return /^@@ .* @@.*$/m.exec(patch)?.[0].endsWith(SNIPPET_LABEL) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function pascalKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pascalKeys);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const pascal = PASCAL_KEYS[key];
    if (pascal === undefined) result[key] ??= pascalKeys(entry);
    else if (value[pascal] == null) result[pascal] = pascalKeys(entry);
  }
  return result;
}

function parseChunk(value: unknown): ReplacementChunk | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value['TargetContent'] !== 'string' || typeof value['ReplacementContent'] !== 'string') {
    return undefined;
  }
  return {
    TargetContent: value['TargetContent'],
    ReplacementContent: value['ReplacementContent'],
    StartLine: positiveInt(value['StartLine']),
    EndLine: positiveInt(value['EndLine']),
  };
}

function parseEditChunks(rawInput: unknown): readonly ReplacementChunk[] | undefined {
  const normalized = pascalKeys(rawInput);
  if (!isRecord(normalized)) return undefined;
  const rawList = normalized['ReplacementChunks'];
  if (Array.isArray(rawList)) {
    if (rawList.length === 0) return undefined;
    const chunks: ReplacementChunk[] = [];
    for (const entry of rawList) {
      const parsed = parseChunk(entry);
      if (parsed === undefined) return undefined;
      chunks.push(parsed);
    }
    return chunks;
  }
  const single = parseChunk(normalized);
  return single === undefined ? undefined : [single];
}

function announcedStartLine(locations: unknown): number | undefined {
  if (!Array.isArray(locations) || locations.length === 0) return undefined;
  const first = locations[0];
  return isRecord(first) ? positiveInt(first['line']) : undefined;
}

function uniqueStartLine(
  text: string | undefined,
  snippet: string,
  from = 1,
  to = Number.POSITIVE_INFINITY,
): number | undefined {
  if (text === undefined || snippet === '') return undefined;
  let found: { readonly line: number; readonly whole: boolean } | undefined;
  let line = 1;
  let lineStart = 0;
  let nextBreak = text.indexOf('\n');
  for (let index = text.indexOf(snippet); index !== -1; index = text.indexOf(snippet, index + 1)) {
    while (nextBreak !== -1 && nextBreak < index) {
      line += 1;
      lineStart = nextBreak + 1;
      nextBreak = text.indexOf('\n', lineStart);
    }
    if (line > to) break;
    if (line < from) continue;
    if (found !== undefined) return undefined;
    const end = index + snippet.length;
    const whole =
      index === lineStart && (end === text.length || snippet.endsWith('\n') || text[end] === '\n');
    found = { line, whole };
  }
  return found?.whole === true ? found.line : undefined;
}

type DiffOp =
  | { readonly kind: 'equal'; readonly line: string }
  | { readonly kind: 'delete'; readonly line: string }
  | { readonly kind: 'insert'; readonly line: string };

function splitLinesForDiff(text: string): string[] {
  if (text === '') return [];
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.split('\n');
}

function computeLineOps(oldLines: readonly string[], newLines: readonly string[], maxEditLength: number): DiffOp[] | undefined {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];
  if (Math.abs(n - m) > maxEditLength) return undefined;

  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < n - prefix &&
    suffix < m - prefix &&
    oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
  ) {
    suffix += 1;
  }

  const a = oldLines.slice(prefix, n - suffix);
  const b = newLines.slice(prefix, m - suffix);
  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ kind: 'equal', line: oldLines[i]! });

  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) {
    if (bLen > maxEditLength) return undefined;
    for (const line of b) ops.push({ kind: 'insert', line });
  } else if (bLen === 0) {
    if (aLen > maxEditLength) return undefined;
    for (const line of a) ops.push({ kind: 'delete', line });
  } else {
    const maxD = Math.min(maxEditLength, aLen + bLen);
    const offset = maxD;
    const v = new Int32Array(2 * maxD + 1).fill(-1);
    v[offset + 1] = 0;
    const trace: Int32Array[] = [];
    let foundD = -1;

    for (let d = 0; d <= maxD; d += 1) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
          x = v[offset + k + 1]!;
        } else {
          x = v[offset + k - 1]! + 1;
        }
        let y = x - k;
        while (x < aLen && y < bLen && a[x] === b[y]) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= aLen && y >= bLen) {
          foundD = d;
          break;
        }
      }
      if (foundD !== -1) break;
    }
    if (foundD === -1) return undefined;

    const midOps: DiffOp[] = [];
    let x = aLen;
    let y = bLen;
    for (let d = foundD; d > 0; d -= 1) {
      const prev = trace[d]!;
      const k = x - y;
      let prevK: number;
      if (k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!)) {
        prevK = k + 1;
      } else {
        prevK = k - 1;
      }
      const prevX = prev[offset + prevK]!;
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x -= 1;
        y -= 1;
        midOps.push({ kind: 'equal', line: a[x]! });
      }
      if (x === prevX) {
        y -= 1;
        midOps.push({ kind: 'insert', line: b[y]! });
      } else {
        x -= 1;
        midOps.push({ kind: 'delete', line: a[x]! });
      }
    }
    while (x > 0 && y > 0) {
      x -= 1;
      y -= 1;
      midOps.push({ kind: 'equal', line: a[x]! });
    }
    midOps.reverse();
    ops.push(...midOps);
  }

  for (let i = n - suffix; i < n; i += 1) ops.push({ kind: 'equal', line: oldLines[i]! });
  return ops;
}

function buildHunks(ops: readonly DiffOp[]): UnifiedHunk[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== 'equal') changeIndices.push(i);
  }
  if (changeIndices.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, idx + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const hunks: UnifiedHunk[] = [];
  for (const range of ranges) {
    let oldLine = 1;
    let newLine = 1;
    for (let i = 0; i < range.start; i += 1) {
      const op = ops[i]!;
      if (op.kind !== 'insert') oldLine += 1;
      if (op.kind !== 'delete') newLine += 1;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    const lines: string[] = [];
    for (let i = range.start; i <= range.end; i += 1) {
      const op = ops[i]!;
      if (op.kind === 'equal') {
        oldCount += 1;
        newCount += 1;
        lines.push(` ${op.line}`);
      } else if (op.kind === 'delete') {
        oldCount += 1;
        lines.push(`-${op.line}`);
      } else {
        newCount += 1;
        lines.push(`+${op.line}`);
      }
    }
    hunks.push({
      oldStart: oldCount === 0 ? Math.max(0, oldStart - 1) : oldStart,
      oldLines: oldCount,
      newStart: newCount === 0 ? Math.max(0, newStart - 1) : newStart,
      newLines: newCount,
      lines,
    });
  }
  return hunks;
}

function snippetHunks(oldText: string, newText: string, maxEditLength: number): UnifiedHunk[] | undefined {
  const before = oldText.replaceAll('\r\n', '\n');
  const after = newText.replaceAll('\r\n', '\n');
  const eol = before.endsWith('\n') ? '' : '\n';
  const oldLines = splitLinesForDiff(before + eol);
  const newLines = splitLinesForDiff(after + eol);
  const ops = computeLineOps(oldLines, newLines, maxEditLength);
  if (ops === undefined) return undefined;
  return buildHunks(ops);
}

function changedLines(hunks: readonly UnifiedHunk[]): number {
  let total = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') || line.startsWith('-')) total += 1;
    }
  }
  return total;
}

function formatHunks(path: string, hunks: readonly UnifiedHunk[], snippet: boolean): string {
  if (hunks.length === 0) return '';
  const output: string[] = [`--- ${path}`, `+++ ${path}`];
  for (const hunk of hunks) {
    const oldRange = hunk.oldLines === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldLines}`;
    const newRange = hunk.newLines === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newLines}`;
    output.push(`@@ -${oldRange} +${newRange} @@${snippet ? SNIPPET_LABEL : ''}`);
    for (const line of hunk.lines) output.push(line);
  }
  return `${output.join('\n')}\n`;
}

export function antigravityEditPatch(input: {
  readonly path: string;
  readonly rawInput: unknown;
  readonly locations?: unknown;
  readonly readPreEditFile?: (path: string) => string | undefined;
}): string | typeof ANTIGRAVITY_EDIT_DIFF_OMITTED | undefined {
  const listed = parseEditChunks(input.rawInput);
  if (listed === undefined) return undefined;
  const announced = announcedStartLine(input.locations);
  const chunks = listed.map((chunk) => ({
    ...chunk,
    StartLine: chunk.StartLine ?? (listed.length === 1 ? announced : undefined),
  }));
  const textSize = chunks.reduce(
    (total, chunk) => total + chunk.TargetContent.length + chunk.ReplacementContent.length,
    0,
  );
  if (textSize > EDIT_TEXT_BUDGET) return ANTIGRAVITY_EDIT_DIFF_OMITTED;

  let file: string | undefined;
  let fileRead = false;
  let budget = EDIT_DIFF_BUDGET;
  const placed: Array<{ readonly start: number; readonly hunks: UnifiedHunk[] }> = [];
  const snippets: UnifiedHunk[] = [];

  for (const chunk of chunks) {
    const targetEndsLine = chunk.TargetContent.endsWith('\n');
    if (
      chunk.ReplacementContent === ''
        ? !targetEndsLine
        : targetEndsLine !== chunk.ReplacementContent.endsWith('\n')
    ) {
      return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    }
    const hunks = snippetHunks(chunk.TargetContent, chunk.ReplacementContent, budget);
    if (
      hunks === undefined ||
      (hunks.length === 0 && chunk.TargetContent !== chunk.ReplacementContent)
    ) {
      return ANTIGRAVITY_EDIT_DIFF_OMITTED;
    }
    budget -= changedLines(hunks);
    if (budget < 0) return ANTIGRAVITY_EDIT_DIFF_OMITTED;

    let start: number | undefined;
    if (input.readPreEditFile !== undefined) {
      if (!fileRead) {
        const loaded = input.readPreEditFile(input.path);
        file = loaded?.replaceAll('\r\n', '\n');
        fileRead = true;
      }
      start = uniqueStartLine(
        file,
        chunk.TargetContent.replaceAll('\r\n', '\n'),
        chunk.StartLine,
        chunk.EndLine,
      );
    }
    if (start === undefined) snippets.push(...hunks);
    else placed.push({ start, hunks });
  }

  if (placed.length > 0 && snippets.length > 0) return ANTIGRAVITY_EDIT_DIFF_OMITTED;

  let shift = 0;
  const placedHunks = placed
    .toSorted((left, right) => left.start - right.start)
    .flatMap(({ start, hunks }) => {
      const shifted = hunks.map((hunk) => ({
        ...hunk,
        oldStart: hunk.oldStart + start - 1,
        newStart: hunk.newStart + start - 1 + shift,
      }));
      for (const hunk of hunks) shift += hunk.newLines - hunk.oldLines;
      return shifted;
    });

  const patch = [
    formatHunks(input.path, placedHunks, false),
    formatHunks(input.path, snippets, true),
  ]
    .filter(Boolean)
    .join('\n');
  return patch || undefined;
}
