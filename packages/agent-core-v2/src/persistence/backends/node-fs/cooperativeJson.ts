function* stringTokens(value: string): Generator<string> {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 16_384);
    if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]!)) end -= 1;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* jsonTokens(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield* stringTokens(value);
  } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    yield JSON.stringify(value);
  } else if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) yield ',';
      yield* jsonTokens(value[index] === undefined ? null : value[index]);
    }
    yield ']';
  } else if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('Cooperative JSON requires plain document objects');
    }
    yield '{';
    let first = true;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      if (!first) yield ',';
      first = false;
      yield* stringTokens(key);
      yield ':';
      yield* jsonTokens(entry);
    }
    yield '}';
  } else {
    throw new TypeError('Cooperative JSON contains an unsupported value');
  }
}

/** Encodes a plain JSON document in bounded slices without cloning it or changing the default document codec. */
export async function encodeCooperativeJson(value: unknown): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let fragments: string[] = [];
  let chars = 0;
  let bytes = 0;
  let deadline = performance.now() + 4;
  let tokens = 0;
  for (const token of jsonTokens(value)) {
    fragments.push(token);
    chars += token.length;
    if (chars >= 65_536) {
      const chunk = encoder.encode(fragments.join(''));
      chunks.push(chunk);
      bytes += chunk.length;
      fragments = [];
      chars = 0;
    }
    if (++tokens % 64 === 0 && performance.now() >= deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      deadline = performance.now() + 4;
    }
  }
  const tail = encoder.encode(fragments.join(''));
  chunks.push(tail);
  const result = new Uint8Array(bytes + tail.length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      deadline = performance.now() + 4;
    }
  }
  return result;
}
