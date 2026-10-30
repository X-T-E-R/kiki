type EncodedScalar = null | boolean | number | string;
type EncodedValue = EncodedScalar | { readonly type: 'undefined' | 'bigint'; readonly value?: string } | { readonly ref: number };
type EncodedNode =
  | { readonly kind: 'array'; readonly values: readonly EncodedValue[] }
  | { readonly kind: 'object'; readonly values: readonly [string, EncodedValue][] }
  | { readonly kind: 'map'; readonly values: readonly [EncodedValue, EncodedValue][] }
  | { readonly kind: 'set'; readonly values: readonly EncodedValue[] }
  | { readonly kind: 'date'; readonly value: string }
  | { readonly kind: 'bytes'; readonly value: string };

export interface ReplayCheckpointGraph {
  readonly version: 1;
  readonly root: EncodedValue;
  readonly nodes: readonly EncodedNode[];
}

const MAX_DEPTH = 128;
const MAX_NODES = 500_000;

function* checkpointGraph(value: unknown): Generator<void, ReplayCheckpointGraph> {
  const seen = new Map<object, number>();
  const nodes: EncodedNode[] = [];
  function* encode(candidate: unknown, depth: number): Generator<void, EncodedValue> {
    yield;
    if (depth > MAX_DEPTH) throw new Error('replay checkpoint graph exceeds maximum depth');
    if (candidate === undefined) return { type: 'undefined' };
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number' || typeof candidate === 'string') {
      return candidate;
    }
    if (typeof candidate === 'bigint') return { type: 'bigint', value: candidate.toString() };
    if (typeof candidate !== 'object') throw new Error('replay checkpoint graph contains an unsupported value');
    const existing = seen.get(candidate);
    if (existing !== undefined) return { ref: existing };
    if (nodes.length >= MAX_NODES) throw new Error('replay checkpoint graph exceeds maximum nodes');
    const ref = nodes.length;
    seen.set(candidate, ref);
    nodes.push({ kind: 'object', values: [] });
    let node: EncodedNode;
    if (Array.isArray(candidate)) {
      const values: EncodedValue[] = [];
      for (let index = 0; index < candidate.length; index += 1) values.push(yield* encode(candidate[index], depth + 1));
      node = { kind: 'array', values };
    } else if (candidate instanceof Map) {
      const values: [EncodedValue, EncodedValue][] = [];
      for (const [key, entry] of candidate) values.push([yield* encode(key, depth + 1), yield* encode(entry, depth + 1)]);
      node = { kind: 'map', values };
    } else if (candidate instanceof Set) {
      const values: EncodedValue[] = [];
      for (const entry of candidate) values.push(yield* encode(entry, depth + 1));
      node = { kind: 'set', values };
    } else if (candidate instanceof Date) {
      node = { kind: 'date', value: candidate.toISOString() };
    } else if (candidate instanceof Uint8Array) {
      const parts: string[] = [];
      for (let offset = 0; offset < candidate.length; offset += 49_152) {
        parts.push(Buffer.from(candidate.buffer, candidate.byteOffset + offset, Math.min(49_152, candidate.length - offset)).toString('base64'));
        yield;
      }
      node = { kind: 'bytes', value: parts.join('') };
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('replay checkpoint graph contains an unsupported object');
      }
      const values: [string, EncodedValue][] = [];
      for (const key in candidate) {
        if (Object.hasOwn(candidate, key)) values.push([key, yield* encode((candidate as Record<string, unknown>)[key], depth + 1)]);
      }
      node = { kind: 'object', values };
    }
    nodes[ref] = node;
    return { ref };
  }
  return { version: 1, root: yield* encode(value, 0), nodes };
}

export function encodeReplayCheckpointGraph(value: unknown): ReplayCheckpointGraph {
  const graph = checkpointGraph(value);
  let step = graph.next();
  while (!step.done) step = graph.next();
  return step.value;
}

export async function encodeReplayCheckpointGraphAsync(value: unknown): Promise<ReplayCheckpointGraph> {
  const graph = checkpointGraph(value);
  let deadline = performance.now() + 4;
  let steps = 0;
  let step = graph.next();
  while (!step.done) {
    if (++steps % 64 === 0 && performance.now() >= deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      deadline = performance.now() + 4;
    }
    step = graph.next();
  }
  return step.value;
}

export function decodeReplayCheckpointGraph(graph: ReplayCheckpointGraph): unknown {
  if (graph.version !== 1 || !Array.isArray(graph.nodes) || graph.nodes.length > MAX_NODES) {
    throw new Error('replay checkpoint graph is invalid');
  }
  const values: unknown[] = graph.nodes.map((node) => {
    if (node.kind === 'array') return [];
    if (node.kind === 'object') return {};
    if (node.kind === 'map') return new Map();
    if (node.kind === 'set') return new Set();
    if (node.kind === 'date') return new Date(node.value);
    if (node.kind === 'bytes') return Uint8Array.from(Buffer.from(node.value, 'base64'));
    throw new Error('replay checkpoint graph node is invalid');
  });
  const decode = (encoded: EncodedValue): unknown => {
    if (encoded === null || typeof encoded === 'boolean' || typeof encoded === 'number' || typeof encoded === 'string') {
      return encoded;
    }
    if ('ref' in encoded) {
      const value = values[encoded.ref];
      if (value === undefined || !Number.isSafeInteger(encoded.ref) || encoded.ref < 0) {
        throw new Error('replay checkpoint graph reference is invalid');
      }
      return value;
    }
    if (encoded.type === 'undefined') return undefined;
    if (encoded.type === 'bigint' && encoded.value !== undefined) return BigInt(encoded.value);
    throw new Error('replay checkpoint graph scalar is invalid');
  };
  graph.nodes.forEach((node, index) => {
    const target = values[index];
    if (node.kind === 'array') {
      for (const entry of node.values) (target as unknown[]).push(decode(entry));
    } else if (node.kind === 'object') {
      for (const [key, entry] of node.values) {
        Object.defineProperty(target, key, {
          value: decode(entry),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    } else if (node.kind === 'map') {
      for (const [key, entry] of node.values) (target as Map<unknown, unknown>).set(decode(key), decode(entry));
    } else if (node.kind === 'set') {
      for (const entry of node.values) (target as Set<unknown>).add(decode(entry));
    }
  });
  return decode(graph.root);
}
