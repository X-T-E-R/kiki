export class StderrRing {
  #value = '';

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    this.#value += chunk;
    while (Buffer.byteLength(this.#value, 'utf8') > this.maxBytes) {
      this.#value = this.#value.slice(Math.max(1, Math.floor(this.#value.length / 8)));
    }
  }

  value(): string {
    return this.#value;
  }
}
