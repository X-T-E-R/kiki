import { LRUCache } from 'lru-cache';

export class ByteLruCache {
  private readonly cache: LRUCache<string, Buffer> | undefined;

  constructor(private readonly maxBytes: number) {
    if (maxBytes > 0) {
      this.cache = new LRUCache<string, Buffer>({
        maxSize: maxBytes,
        sizeCalculation: (value) => Math.max(1, value.byteLength),
      });
    }
  }

  get(key: string): Buffer | undefined {
    return this.cache?.get(key);
  }

  set(key: string, value: Buffer): void {
    if (this.cache === undefined) return;
    if (value.byteLength > this.maxBytes) {
      this.cache.delete(key);
      return;
    }
    this.cache.set(key, value);
  }

  delete(key: string): boolean {
    return this.cache?.delete(key) ?? false;
  }
}
