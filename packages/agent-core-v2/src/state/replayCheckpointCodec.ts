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

export function encodeReplayCheckpointGraph(value: unknown): ReplayCheckpointGraph {
  const seen = new Map<object, number>();
  const nodes: EncodedNode[] = [];
  const encode = (candidate: unknown, depth: number): EncodedValue => {
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
      node = { kind: 'array', values: candidate.map((entry) => encode(entry, depth + 1)) };
    } else if (candidate instanceof Map) {
      node = {
        kind: 'map',
        values: [...candidate].map(([key, entry]) => [encode(key, depth + 1), encode(entry, depth + 1)]),
      };
    } else if (candidate instanceof Set) {
      node = { kind: 'set', values: [...candidate].map((entry) => encode(entry, depth + 1)) };
    } else if (candidate instanceof Date) {
      node = { kind: 'date', value: candidate.toISOString() };
    } else if (candidate instanceof Uint8Array) {
      node = { kind: 'bytes', value: Buffer.from(candidate).toString('base64') };
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('replay checkpoint graph contains an unsupported object');
      }
      node = {
        kind: 'object',
        values: Object.entries(candidate).map(([key, entry]) => [key, encode(entry, depth + 1)]),
      };
    }
    nodes[ref] = node;
    return { ref };
  };
  return { version: 1, root: encode(value, 0), nodes };
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
