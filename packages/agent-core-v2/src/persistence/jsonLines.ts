const encoder = new TextEncoder();
const CHUNK_BYTES = 1 << 20;

export function* encodeJsonLines(records: Iterable<unknown>): Generator<Uint8Array> {
  let buffer = new Uint8Array(CHUNK_BYTES);
  let used = 0;
  for (const record of records) {
    const line = JSON.stringify(record) + '\n';
    let offset = 0;
    while (offset < line.length) {
      const { read, written } = encoder.encodeInto(line.slice(offset), buffer.subarray(used));
      offset += read;
      used += written;
      if (offset < line.length || used === buffer.byteLength) {
        yield buffer.subarray(0, used);
        buffer = new Uint8Array(CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used > 0) yield buffer.subarray(0, used);
}
