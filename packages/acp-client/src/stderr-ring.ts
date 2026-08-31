export class StderrRingBuffer {
  readonly #maxBytes: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = Math.max(0, maxBytes);
  }

  append(chunk: string | Buffer): void {
    if (this.#maxBytes === 0) return;
    let value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, 'utf8');
    if (value.byteLength >= this.#maxBytes) {
      value = value.subarray(value.byteLength - this.#maxBytes);
      this.#chunks.splice(0, this.#chunks.length, value);
      this.#bytes = value.byteLength;
      return;
    }
    this.#chunks.push(value);
    this.#bytes += value.byteLength;
    while (this.#bytes > this.#maxBytes) {
      const overflow = this.#bytes - this.#maxBytes;
      const first = this.#chunks[0];
      if (first === undefined) break;
      if (first.byteLength <= overflow) {
        this.#chunks.shift();
        this.#bytes -= first.byteLength;
      } else {
        this.#chunks[0] = first.subarray(overflow);
        this.#bytes -= overflow;
      }
    }
  }

  clear(): void {
    this.#chunks.length = 0;
    this.#bytes = 0;
  }

  toString(): string {
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }
}
