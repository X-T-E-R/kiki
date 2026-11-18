const encoder = new TextEncoder();
const CHUNK_BYTES = 1 << 20;

function concatByteParts(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

export function* encodeJsonLines(records: Iterable<unknown>): Generator<Uint8Array> {
  let parts: Uint8Array[] = [];
  let bufferedBytes = 0;
  for (const record of records) {
    const lineBytes = encoder.encode(`${JSON.stringify(record)}\n`);
    if (bufferedBytes > 0 && bufferedBytes + lineBytes.byteLength > CHUNK_BYTES) {
      yield concatByteParts(parts, bufferedBytes);
      parts = [];
      bufferedBytes = 0;
    }
    if (lineBytes.byteLength >= CHUNK_BYTES) {
      for (let offset = 0; offset < lineBytes.byteLength; offset += CHUNK_BYTES) {
        yield lineBytes.subarray(offset, Math.min(lineBytes.byteLength, offset + CHUNK_BYTES));
      }
      continue;
    }
    parts.push(lineBytes);
    bufferedBytes += lineBytes.byteLength;
  }
  if (bufferedBytes > 0) {
    yield concatByteParts(parts, bufferedBytes);
  }
}
