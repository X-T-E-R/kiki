function sliceIndex(index: number, length: number): number {
  const integer = Math.trunc(index) || 0;
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}

function splitsSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Like String.slice, with bounds moved inward to preserve complete UTF-16 surrogate pairs. */
export function sliceUtf16(text: string, start = 0, end = text.length): string {
  const from = sliceIndex(start, text.length);
  const to = sliceIndex(end, text.length);
  return text.slice(
    splitsSurrogatePair(text, from) ? from + 1 : from,
    splitsSurrogatePair(text, to) ? to - 1 : to,
  );
}
