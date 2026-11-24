import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { installStdioEpipeGuard, isBenignStdioError, safeWriteStream } from '../src/lib/stdioGuard';

function codedError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('stdioGuard', () => {
  it('classifies EPIPE, ERR_STREAM_DESTROYED, and EOF as benign stdio errors', () => {
    expect(isBenignStdioError(codedError('EPIPE'))).toBe(true);
    expect(isBenignStdioError(codedError('ERR_STREAM_DESTROYED'))).toBe(true);
    expect(isBenignStdioError(codedError('EOF'))).toBe(true);
    expect(isBenignStdioError(codedError('EACCES'))).toBe(false);
    expect(isBenignStdioError(new Error('plain'))).toBe(false);
    expect(isBenignStdioError(null)).toBe(false);
  });

  it('installs idempotently and absorbs EPIPE/ERR_STREAM_DESTROYED/EOF without throwing', () => {
    const out = new PassThrough();
    const err = new PassThrough();
    installStdioEpipeGuard([out, err]);
    installStdioEpipeGuard([out, err]);
    expect(out.listenerCount('error')).toBe(1);
    expect(err.listenerCount('error')).toBe(1);

    expect(() => out.emit('error', codedError('EPIPE'))).not.toThrow();
    expect(() => err.emit('error', codedError('ERR_STREAM_DESTROYED'))).not.toThrow();
    expect(() => err.emit('error', codedError('EOF'))).not.toThrow();
    expect(() => err.emit('error', codedError('EACCES'))).toThrow('EACCES');
  });

  it('safeWriteStream absorbs closed streams and synchronous EPIPE writes', () => {
    const destroyed = new PassThrough();
    destroyed.destroy();
    expect(() => safeWriteStream(destroyed, 'ignored')).not.toThrow();

    const broken = new PassThrough();
    broken.write = (() => {
      throw codedError('EPIPE');
    }) as typeof broken.write;
    expect(() => safeWriteStream(broken, 'broken pipe write')).not.toThrow();
  });
});
