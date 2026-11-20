const V8_SLICED_STRING_MIN_LENGTH = 13;

/** Detaches a potentially sliced substring from a larger V8 parent string. */
export function detachSlicedString(value: string): string {
  return value.length >= V8_SLICED_STRING_MIN_LENGTH
    ? Buffer.from(value, 'utf8').toString('utf8')
    : value;
}
