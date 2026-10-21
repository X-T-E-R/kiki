import { PassThrough, Readable } from 'node:stream';
import { setImmediate as defer } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { BufferedReadable } from '#/_base/execEnv/bufferedReadable';

async function collectText(readable: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      throw new Error(`timed out after ${timeoutMs}ms`);
    })(),
  ]);
}

describe('BufferedReadable', () => {
  it('ends when the source already reached EOF before the wrapper existed', async () => {
    const source = new Readable({ read() {} });
    source.push(null);
    source.resume();
    await new Promise<void>((resolve) => {
      source.once('end', () => resolve());
    });
    expect(source.readableEnded).toBe(true);

    const buffered = new BufferedReadable(source);
    await expect(withTimeout(collectText(buffered), 250)).resolves.toBe('');
  });

  it('delivers bytes already buffered on a paused source and then EOF', async () => {
    const source = new PassThrough();
    source.write(Buffer.from('kept-bytes'));
    source.end();
    expect(source.readableLength).toBeGreaterThan(0);
    expect(source.readableEnded).toBe(false);

    const buffered = new BufferedReadable(source);
    await expect(withTimeout(collectText(buffered), 250)).resolves.toBe('kept-bytes');
  });

  it('delivers bytes still sitting on a destroyed source instead of ending empty', async () => {
    const source = new PassThrough();
    source.write(Buffer.from('kept-bytes'));
    source.destroy();
    expect(source.destroyed).toBe(true);
    expect(source.readableLength).toBeGreaterThan(0);
    expect(source.errored).toBeNull();

    const buffered = new BufferedReadable(source);
    await expect(withTimeout(collectText(buffered), 250)).resolves.toBe('kept-bytes');
  });

  it('surfaces an error already stored on the source instead of a clean EOF', async () => {
    const source = new PassThrough();
    const boom = new Error('already failed');
    source.on('error', () => {});
    source.destroy(boom);
    await defer();
    expect(source.errored).toBe(boom);

    const buffered = new BufferedReadable(source);
    const failed = withTimeout(collectText(buffered), 250);
    await expect(failed).rejects.toBe(boom);
  });

  it('surfaces an error that arrives after construction', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const boom = new Error('source boom');
    const errorReceived = new Promise<Error>((resolve) => {
      buffered.on('error', (error: Error) => resolve(error));
    });

    source.destroy(boom);

    await expect(withTimeout(errorReceived, 250)).resolves.toBe(boom);
    expect(buffered.destroyed).toBe(true);
  });
});
