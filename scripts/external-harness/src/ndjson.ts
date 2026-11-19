import type { Readable, Writable } from 'node:stream';
import { MAX_FRAME_BYTES } from './types';

export interface NdjsonLineOptions {
  maxFrameBytes?: number;
  signal?: AbortSignal;
}

export function createNdjsonLineTransform(
  options: { maxFrameBytes?: number } = {},
): TransformStream<Uint8Array | string, string> {
  const maxFrameBytes = options.maxFrameBytes;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const checkLimit = (text: string): void => {
    if (maxFrameBytes !== undefined && Buffer.byteLength(text) > maxFrameBytes) {
      throw new Error(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
    }
  };

  return new TransformStream<Uint8Array | string, string>({
    transform(chunk, controller) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        checkLimit(line);
        controller.enqueue(line);
      }
      checkLimit(buffer);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        checkLimit(line);
        controller.enqueue(line);
        buffer = '';
      }
    },
  });
}

export async function* readNdjsonLines(
  stream: Readable,
  options: NdjsonLineOptions = {},
): AsyncGenerator<string> {
  const { maxFrameBytes, signal } = options;
  if (signal?.aborted) return;

  const decoder = new TextDecoder('utf-8');
  const queue: string[] = [];
  let buffer = '';
  let ended = false;
  let streamError: unknown;
  let hasError = false;
  let notify: (() => void) | undefined;

  const wake = (): void => {
    const fn = notify;
    notify = undefined;
    fn?.();
  };

  const checkLimit = (text: string): boolean => {
    if (maxFrameBytes !== undefined && Buffer.byteLength(text) > maxFrameBytes) {
      streamError = new Error(`NDJSON frame exceeds ${maxFrameBytes} bytes`);
      hasError = true;
      ended = true;
      stream.pause();
      wake();
      return false;
    }
    return true;
  };

  const onData = (chunk: Buffer | string): void => {
    if (ended) return;
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (!checkLimit(line)) return;
      queue.push(line);
    }
    if (!checkLimit(buffer)) return;
    if (queue.length > 0) {
      stream.pause();
      wake();
    }
  };

  const onEnd = (): void => {
    if (ended) return;
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      buffer = '';
      if (!checkLimit(line)) return;
      queue.push(line);
    }
    ended = true;
    wake();
  };

  const onError = (error: unknown): void => {
    if (ended) return;
    streamError = error;
    hasError = true;
    ended = true;
    wake();
  };

  const onClose = (): void => {
    if (ended) return;
    ended = true;
    wake();
  };

  const onAbort = (): void => {
    ended = true;
    stream.pause();
    wake();
  };

  stream.on('data', onData);
  stream.once('end', onEnd);
  stream.once('error', onError);
  stream.once('close', onClose);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      while (queue.length > 0) {
        if (signal?.aborted) return;
        yield queue.shift()!;
      }
      if (hasError) {
        throw streamError instanceof Error ? streamError : new Error(String(streamError));
      }
      if (ended || signal?.aborted) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
        stream.resume();
      });
    }
  } finally {
    stream.off('data', onData);
    stream.off('end', onEnd);
    stream.off('error', onError);
    stream.off('close', onClose);
    signal?.removeEventListener('abort', onAbort);
    stream.pause();
  }
}

export interface NdjsonFrameDecoderOptions<T> {
  maxFrameBytes?: number;
  reviver?: (key: string, value: unknown) => unknown;
  onFrame: (frame: T) => void;
  onError: (error: Error) => void;
}

export class NdjsonFrameDecoder<T = unknown> {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly maxFrameBytes: number;
  private readonly reviver?: (key: string, value: unknown) => unknown;
  private readonly onFrame: (frame: T) => void;
  private readonly onError: (error: Error) => void;
  private buffer = '';
  private failed = false;

  constructor(options: NdjsonFrameDecoderOptions<T>) {
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.reviver = options.reviver;
    this.onFrame = options.onFrame;
    this.onError = options.onError;
  }

  stop(): void {
    this.failed = true;
  }

  push(chunk: Uint8Array | string): void {
    if (this.failed) return;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.failed = true;
        this.onError(new Error('AGY stdout frame exceeds 1 MiB'));
        return;
      }
      let parsed: T;
      try {
        parsed = JSON.parse(line, this.reviver) as T;
      } catch {
        this.failed = true;
        this.onError(new Error('AGY emitted invalid NDJSON'));
        return;
      }
      this.onFrame(parsed);
      if (this.failed) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.failed = true;
      this.onError(new Error('AGY stdout frame exceeds 1 MiB'));
    }
  }
}

export function writeNdjsonFrame(stream: Writable, frame: string): Promise<void> {
  return new Promise<void>((done, reject) => {
    stream.write(frame, (error) => (error ? reject(error) : done()));
  });
}
