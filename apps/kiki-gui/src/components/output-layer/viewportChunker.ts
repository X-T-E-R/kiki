/**
 * viewportChunker — intelligent text chunking algorithm for Kiki Output Layer.
 *
 * Chunks text into slices of approximately `targetChunkSize` (default 600 Unicode chars),
 * intelligently snapping to paragraph (\n\n), line (\n), or sentence punctuation boundaries
 * (。！？.!?), without tearing words, code fences, or punctuation marks.
 */

export interface TextChunk {
  index: number;
  start: number;
  end: number;
  text: string;
}

export const DEFAULT_CHUNK_SIZE = 600;

const PARAGRAPH_BREAK = '\n\n';
const LINE_BREAK = '\n';

export interface CodeFence {
  start: number;
  end: number;
}

/**
 * Scans text for Markdown code fences (``` or ~~~).
 * Returns non-overlapping ranges of fenced code blocks.
 */
export function findCodeFences(text: string): CodeFence[] {
  const fences: CodeFence[] = [];
  const lineRegex = /(?:^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\n]*)(?:\n|$)/g;
  let activeFence: { start: number; char: string; len: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = lineRegex.exec(text)) !== null) {
    const fullMatch = match[0];
    const fenceToken = match[2]!;
    const char = fenceToken[0]!;
    const len = fenceToken.length;
    const hasLeadingNewline = fullMatch.startsWith('\n');
    const lineStart = match.index + (hasLeadingNewline ? 1 : 0);
    const lineEnd = match.index + fullMatch.length;

    if (!activeFence) {
      activeFence = { start: lineStart, char, len };
    } else {
      const info = match[3]?.trim() ?? '';
      if (char === activeFence.char && len >= activeFence.len && info === '') {
        fences.push({
          start: activeFence.start,
          end: lineEnd,
        });
        activeFence = null;
      }
    }
  }

  if (activeFence) {
    fences.push({
      start: activeFence.start,
      end: text.length,
    });
  }

  return fences;
}

/**
 * Splits text into semantic chunks near `targetSize` characters.
 */
export function chunkText(text: string, targetSize = DEFAULT_CHUNK_SIZE): TextChunk[] {
  if (!text || text.trim() === '') {
    return [];
  }

  // If text is shorter than targetSize, return single chunk
  if (Array.from(text).length <= targetSize) {
    return [{ index: 0, start: 0, end: text.length, text }];
  }

  const fences = findCodeFences(text);
  const chunks: TextChunk[] = [];
  let currentStart = 0;
  const fullLength = text.length;

  while (currentStart < fullLength) {
    const remaining = text.slice(currentStart);
    const remainingChars = Array.from(remaining).length;

    if (remainingChars <= targetSize) {
      chunks.push({
        index: chunks.length,
        start: currentStart,
        end: fullLength,
        text: remaining,
      });
      break;
    }

    // Find the ideal cut position near currentStart + targetSize
    const cutPos = findBestCutPosition(text, currentStart, targetSize, fences);
    const safeCutPos = Math.max(currentStart + 1, Math.min(cutPos, fullLength));
    const chunkSlice = text.slice(currentStart, safeCutPos);

    chunks.push({
      index: chunks.length,
      start: currentStart,
      end: safeCutPos,
      text: chunkSlice,
    });

    currentStart = safeCutPos;
  }

  return chunks;
}

/**
 * Finds the best boundary position in `text` starting from `start` targeting `targetChars`.
 */
function findBestCutPosition(
  text: string,
  start: number,
  targetChars: number,
  fences: CodeFence[],
): number {
  // Convert targetChars to approximate JS string index
  const textFromStart = text.slice(start);
  const chars = Array.from(textFromStart);
  const desiredCharIndex = Math.min(chars.length, targetChars);

  const rawTargetStringIndex = chars.slice(0, desiredCharIndex).join('').length;
  const idealCut = start + rawTargetStringIndex;

  // 1. Check if idealCut intersects any code fence
  const intersectingFence = fences.find((f) => f.start < idealCut && idealCut < f.end);
  if (intersectingFence) {
    // If the fence started after `start`, cut before the fence
    if (intersectingFence.start > start) {
      const preFenceText = text.slice(start, intersectingFence.start);
      const pIdx = preFenceText.lastIndexOf(PARAGRAPH_BREAK);
      if (pIdx !== -1 && start + pIdx + PARAGRAPH_BREAK.length > start) {
        return start + pIdx + PARAGRAPH_BREAK.length;
      }
      const sentenceMatches = [...preFenceText.matchAll(/[。！？]|\. |\? |! |\.\n|\?\n|!\n/g)];
      if (sentenceMatches.length > 0) {
        const lastMatch = sentenceMatches[sentenceMatches.length - 1]!;
        const cut = start + lastMatch.index! + lastMatch[0].length;
        if (cut > start) return cut;
      }
      const lIdx = preFenceText.lastIndexOf(LINE_BREAK);
      if (lIdx !== -1 && start + lIdx + 1 > start) {
        return start + lIdx + 1;
      }
      return intersectingFence.start;
    } else {
      // Chunk started at or inside fence: keep entire fenced semantic unit intact
      return Math.min(intersectingFence.end, text.length);
    }
  }

  const windowStart = Math.max(0, Math.floor(rawTargetStringIndex * 0.7));
  const windowEnd = Math.min(textFromStart.length, Math.floor(rawTargetStringIndex * 1.3));
  const searchWindow = textFromStart.slice(windowStart, windowEnd);

  const isCutInsideFence = (cut: number) =>
    fences.some((f) => f.start < cut && cut < f.end);

  // 2. Paragraph break (\n\n)
  const paragraphMatches = [...searchWindow.matchAll(/\n\n/g)];
  if (paragraphMatches.length > 0) {
    for (let i = paragraphMatches.length - 1; i >= 0; i--) {
      const cut = start + windowStart + paragraphMatches[i]!.index! + PARAGRAPH_BREAK.length;
      if (cut > start && !isCutInsideFence(cut)) return cut;
    }
  }

  // 3. Sentence end (Chinese 。！？ or English .!? followed by whitespace)
  const sentenceMatches = [...searchWindow.matchAll(/[。！？]|\. |\? |! |\.\n|\?\n|!\n/g)];
  if (sentenceMatches.length > 0) {
    for (let i = sentenceMatches.length - 1; i >= 0; i--) {
      const lastMatch = sentenceMatches[i]!;
      const cut = start + windowStart + lastMatch.index! + lastMatch[0].length;
      if (cut > start && !isCutInsideFence(cut)) return cut;
    }
  }

  // 4. Line break (\n)
  const lineMatches = [...searchWindow.matchAll(/\n/g)];
  if (lineMatches.length > 0) {
    for (let i = lineMatches.length - 1; i >= 0; i--) {
      const cut = start + windowStart + lineMatches[i]!.index! + LINE_BREAK.length;
      if (cut > start && !isCutInsideFence(cut)) return cut;
    }
  }

  // 5. Clause punctuation (，, ；; ：:)
  const clauseMatches = [...searchWindow.matchAll(/[，,；;：:]/g)];
  if (clauseMatches.length > 0) {
    for (let i = clauseMatches.length - 1; i >= 0; i--) {
      const lastMatch = clauseMatches[i]!;
      const cut = start + windowStart + lastMatch.index! + lastMatch[0].length;
      if (cut > start && !isCutInsideFence(cut)) return cut;
    }
  }

  // 6. Whitespace (space, tab)
  const spaceMatches = [...searchWindow.matchAll(/ /g)];
  if (spaceMatches.length > 0) {
    for (let i = spaceMatches.length - 1; i >= 0; i--) {
      const cut = start + windowStart + spaceMatches[i]!.index! + 1;
      if (cut > start && !isCutInsideFence(cut)) return cut;
    }
  }

  // Fallback: hard cut at target character count
  return idealCut;
}
