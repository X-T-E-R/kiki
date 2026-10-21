import { Readable } from 'node:stream';

export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;

  constructor(source: Readable) {
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    const pendingError = source.errored;
    if (source.readableFlowing !== true && source.readableLength > 0) {
      let chunk: string | Buffer | null = source.read();
      while (chunk !== null) {
        this.push(chunk);
        chunk = source.read();
      }
    }
    this._source.on('data', this._onData);
    this._source.on('end', this._onEnd);
    this._source.on('close', this._onClose);
    this._source.on('error', this._onError);
    if (pendingError) {
      queueMicrotask(() => {
        if (!this.destroyed) this.destroy(pendingError);
      });
      return;
    }
    if ((source.readableEnded || source.destroyed) && source.readableLength === 0) {
      this._ended = true;
      this.push(null);
    }
  }

  override _read(): void {
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._source.off('data', this._onData);
    this._source.off('end', this._onEnd);
    this._source.off('close', this._onClose);
    this._source.off('error', this._onError);
    this._source.destroy();
    callback(error);
  }

  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
    }
  };

  private readonly _onEnd = (): void => {
    this._ended = true;
    this.push(null);
  };

  private readonly _onClose = (): void => {
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}
