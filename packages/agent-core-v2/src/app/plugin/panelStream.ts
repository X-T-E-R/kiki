import { createConnection, type Socket } from 'node:net';
import { isBrokenPipeError, isWritableStreamOpen } from '#/_base/errors/brokenPipe';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export interface PluginPanelStream {
  readonly result: unknown;
  sendBinary(chunk: Uint8Array | ArrayBuffer): boolean;
  sendText(text: string): boolean;
  close(reason?: string): void;
  onBinary(listener: (chunk: Buffer) => void): () => void;
  onText(listener: (text: string) => void): () => void;
  onClose(listener: (reason?: string) => void): () => void;
  bufferedAmount(): number;
}

export class PanelStream implements PluginPanelStream {
  private readonly binary = new Set<(chunk: Buffer) => void>();
  private readonly text = new Set<(text: string) => void>();
  private readonly closed = new Set<(reason?: string) => void>();
  private pendingBinary: Buffer[] = [];
  private pendingText: string[] = [];
  private pendingBinaryBytes = 0;
  private pendingTextBytes = 0;
  private ended = false;
  private reason?: string;
  private readonly header = Buffer.allocUnsafe(5);
  private headerBytes = 0;
  private payload?: Buffer;
  private payloadBytes = 0;
  private length = 0;
  private readonly socket: Socket;

  constructor(readonly result: unknown, port: number, token: string, private readonly onEnd: () => void) {
    this.socket = createConnection({ host: '127.0.0.1', port, noDelay: true });
    this.socket.on('data', (chunk) => this.receive(chunk));
    this.socket.on('error', (error) => this.destroy(error.message));
    this.socket.on('close', () => this.destroy());
    this.socket.once('connect', () => {
      if (this.ended || !isWritableStreamOpen(this.socket)) {
        this.destroy('Plugin stream closed before handshake');
        return;
      }
      try {
        this.socket.write(Buffer.from(token, 'hex'));
      } catch (error) {
        if (isBrokenPipeError(error)) {
          this.destroy(error instanceof Error ? error.message : String(error));
          return;
        }
        throw error;
      }
    });
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.destroy('Plugin stream connect timed out'), 10_000);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); this.socket.off('connect', connected); this.closed.delete(closed); };
      const connected = () => { cleanup(); resolve(); };
      const closed = (reason?: string) => { cleanup(); reject(new Error(reason ?? 'Plugin stream closed before connecting')); };
      this.socket.once('connect', connected);
      this.closed.add(closed);
    });
  }

  sendBinary(chunk: Uint8Array | ArrayBuffer): boolean {
    return this.send(2, chunk instanceof ArrayBuffer ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  }

  sendText(text: string): boolean { return this.send(1, Buffer.from(text)); }

  async sendBinaryAsync(chunk: Uint8Array | ArrayBuffer, signal?: AbortSignal): Promise<void> {
    const buffer = chunk instanceof ArrayBuffer
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    await this.sendAsync(2, buffer, signal);
  }

  async sendTextAsync(text: string, signal?: AbortSignal): Promise<void> {
    await this.sendAsync(1, Buffer.from(text, 'utf8'), signal);
  }

  private async sendAsync(opcode: number, payload: Buffer, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.ended) throw new Error(this.reason ?? 'Plugin stream closed');
    if (payload.length > MAX_FRAME_BYTES) {
      this.destroy('Plugin stream frame limit exceeded');
      throw new Error('Plugin stream frame limit exceeded');
    }
    if (this.socket.writableLength > MAX_UPLOAD_CHUNK_BYTES) {
      await this.waitDrain(signal);
    }
    signal?.throwIfAborted();
    if (this.ended || !isWritableStreamOpen(this.socket)) {
      const reason = this.reason ?? 'Plugin stream closed';
      this.destroy(reason);
      throw new Error(reason);
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = opcode;
    header.writeUInt32BE(payload.length, 1);
    let writable: boolean;
    try {
      this.socket.cork();
      this.socket.write(header);
      writable = this.socket.write(payload);
      this.socket.uncork();
    } catch (error) {
      if (!this.socket.destroyed) {
        try { this.socket.uncork(); } catch {}
      }
      if (isBrokenPipeError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        this.destroy(message);
        throw new Error(message, { cause: error });
      }
      throw error;
    }
    if (!writable) await this.waitDrain(signal);
  }

  private waitDrain(signal?: AbortSignal): Promise<void> {
    if (this.ended) return Promise.reject(new Error(this.reason ?? 'Plugin stream closed'));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.socket.off('drain', onDrain);
        this.closed.delete(onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = (why?: string) => { cleanup(); reject(new Error(why ?? 'Plugin stream closed')); };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      this.socket.once('drain', onDrain);
      this.closed.add(onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private send(opcode: number, payload: Buffer): boolean {
    if (this.ended) return false;
    if (!isWritableStreamOpen(this.socket)) {
      this.destroy(this.reason ?? 'Plugin stream closed');
      return false;
    }
    if (payload.length > MAX_FRAME_BYTES || this.socket.writableLength + payload.length + 5 > MAX_FRAME_BYTES + 5) {
      this.destroy('Plugin stream buffer limit exceeded');
      return false;
    }
    const header = Buffer.allocUnsafe(5);
    header[0] = opcode;
    header.writeUInt32BE(payload.length, 1);
    try {
      this.socket.cork();
      this.socket.write(header);
      const writable = this.socket.write(payload);
      this.socket.uncork();
      return writable;
    } catch (error) {
      if (!this.socket.destroyed) {
        try { this.socket.uncork(); } catch {}
      }
      if (isBrokenPipeError(error)) {
        this.destroy(error instanceof Error ? error.message : String(error));
        return false;
      }
      throw error;
    }
  }

  close(reason?: string): void {
    if (!this.ended) this.send(8, Buffer.from(reason ?? ''));
    this.destroy(reason, true);
  }

  destroy(reason?: string, graceful = false): void {
    if (this.ended) return;
    this.ended = true;
    this.reason = reason;
    if (graceful && !this.socket.destroyed) {
      try {
        this.socket.end();
      } catch {
        this.socket.destroy();
      }
      const timer = setTimeout(() => this.socket.destroy(), 1000);
      timer.unref();
      this.socket.once('close', () => clearTimeout(timer));
    } else this.socket.destroy();
    this.payload = undefined;
    this.pendingBinary = [];
    this.pendingText = [];
    this.pendingBinaryBytes = 0;
    this.pendingTextBytes = 0;
    this.onEnd();
    for (const listener of this.closed) listener(reason);
    this.binary.clear(); this.text.clear(); this.closed.clear();
  }

  onBinary(listener: (chunk: Buffer) => void): () => void {
    if (this.ended) return () => {};
    this.binary.add(listener);
    if (this.pendingBinary.length > 0) {
      const queued = this.pendingBinary;
      this.pendingBinary = [];
      this.pendingBinaryBytes = 0;
      for (const frame of queued) {
        if (this.ended) break;
        for (const candidate of this.binary) {
          if (this.ended) break;
          candidate(frame);
        }
      }
    }
    return () => { this.binary.delete(listener); };
  }

  onText(listener: (text: string) => void): () => void {
    if (this.ended) return () => {};
    this.text.add(listener);
    if (this.pendingText.length > 0) {
      const queued = this.pendingText;
      this.pendingText = [];
      this.pendingTextBytes = 0;
      for (const frame of queued) {
        if (this.ended) break;
        for (const candidate of this.text) {
          if (this.ended) break;
          candidate(frame);
        }
      }
    }
    return () => { this.text.delete(listener); };
  }
  onClose(listener: (reason?: string) => void): () => void {
    if (this.ended) { listener(this.reason); return () => {}; }
    this.closed.add(listener);
    return () => { this.closed.delete(listener); };
  }
  bufferedAmount(): number { return this.socket.writableLength; }

  private receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.ended) {
      if (this.headerBytes < 5) {
        const bytes = Math.min(5 - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + bytes);
        this.headerBytes += bytes; offset += bytes;
        if (this.headerBytes !== 5) return;
        this.length = this.header.readUInt32BE(1);
        if (this.length > MAX_FRAME_BYTES || ![1, 2, 8].includes(this.header[0]!)) { this.destroy('Invalid plugin stream frame'); return; }
      }
      const bytes = Math.min(this.length - this.payloadBytes, chunk.length - offset);
      let frame: Buffer;
      if (this.payload === undefined && bytes === this.length) frame = chunk.subarray(offset, offset + bytes);
      else {
        this.payload ??= Buffer.allocUnsafe(this.length);
        chunk.copy(this.payload, this.payloadBytes, offset, offset + bytes);
        this.payloadBytes += bytes;
        if (this.payloadBytes !== this.length) return;
        frame = this.payload;
      }
      offset += bytes;
      const opcode = this.header[0];
      this.headerBytes = 0; this.payloadBytes = 0; this.payload = undefined;
      if (opcode === 8) this.destroy(frame.toString('utf8'));
      else if (opcode === 1) {
        const text = frame.toString('utf8');
        if (this.text.size === 0) {
          if (this.pendingBinaryBytes + this.pendingTextBytes + frame.length > MAX_FRAME_BYTES) {
            this.destroy('Plugin stream buffer limit exceeded');
            return;
          }
          this.pendingText.push(text);
          this.pendingTextBytes += frame.length;
        } else {
          for (const listener of this.text) listener(text);
        }
      } else {
        if (this.binary.size === 0) {
          if (this.pendingBinaryBytes + this.pendingTextBytes + frame.length > MAX_FRAME_BYTES) {
            this.destroy('Plugin stream buffer limit exceeded');
            return;
          }
          this.pendingBinary.push(Buffer.from(frame));
          this.pendingBinaryBytes += frame.length;
        } else {
          for (const listener of this.binary) listener(frame);
        }
      }
    }
  }
}
