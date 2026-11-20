type StackEntry =
  | { readonly kind: 'array'; readonly items: readonly unknown[]; index: number }
  | { readonly kind: 'object'; readonly target: Record<string, unknown>; readonly keys: readonly string[]; index: number; emitted: boolean };

function appendStringFragments(value: string, push: (fragment: string) => void): void {
  if (value.length <= 16_384) {
    push(JSON.stringify(value));
    return;
  }
  push('"');
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + 16_384);
    if (end < value.length) {
      const code = value.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    push(JSON.stringify(value.slice(offset, end)).slice(1, -1));
    offset = end;
  }
  push('"');
}

function assertPlainObject(value: object): void {
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('Cooperative JSON requires plain document objects');
  }
}

/** Encodes a plain JSON document in bounded slices without cloning it or changing the default document codec. */
export async function encodeCooperativeJson(value: unknown): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let fragments: string[] = [];
  let chars = 0;
  let bytes = 0;
  let deadline = performance.now() + 2;
  let steps = 0;

  const flushFragments = (): void => {
    if (chars === 0) return;
    const chunk = encoder.encode(fragments.join(''));
    chunks.push(chunk);
    bytes += chunk.length;
    fragments = [];
    chars = 0;
  };

  const push = (fragment: string): void => {
    fragments.push(fragment);
    chars += fragment.length;
    if (chars >= 65_536) flushFragments();
  };

  const stack: StackEntry[] = [];
  const emitValue = (item: unknown): void => {
    if (typeof item === 'string') {
      appendStringFragments(item, push);
    } else if (item === null || typeof item === 'number' || typeof item === 'boolean') {
      push(JSON.stringify(item));
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        push('[]');
      } else {
        push('[');
        stack.push({ kind: 'array', items: item, index: 0 });
      }
    } else if (typeof item === 'object') {
      assertPlainObject(item);
      const keys = Object.keys(item);
      if (keys.length === 0) {
        push('{}');
      } else {
        push('{');
        stack.push({ kind: 'object', target: item as Record<string, unknown>, keys, index: 0, emitted: false });
      }
    } else {
      throw new TypeError('Cooperative JSON contains an unsupported value');
    }
  };

  emitValue(value);
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.kind === 'array') {
      if (top.index >= top.items.length) {
        stack.pop();
        push(']');
      } else {
        const idx = top.index++;
        if (idx > 0) push(',');
        const element = top.items[idx];
        emitValue(element === undefined ? null : element);
      }
    } else if (top.index >= top.keys.length) {
      stack.pop();
      push('}');
    } else {
      const key = top.keys[top.index++]!;
      const entry = top.target[key];
      if (entry !== undefined) {
        if (top.emitted) push(',');
        top.emitted = true;
        appendStringFragments(key, push);
        push(':');
        emitValue(entry);
      }
    }
    if ((++steps & 127) === 0 && performance.now() >= deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      deadline = performance.now() + 2;
    }
  }

  const tail = encoder.encode(fragments.join(''));
  chunks.push(tail);
  if (chunks.length === 1) return tail;
  const result = new Uint8Array(bytes + tail.length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      deadline = performance.now() + 2;
    }
  }
  return result;
}
