import { timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { loadOrCreateServerToken, serverTokenPath } from './persistentToken';

export interface TokenStore {
  readonly tokenPath: string;
  getToken(): string;
  isValid(candidate: string): boolean;
  generation(): number;
  dispose(): Promise<void>;
}

/**
 * Persistent token store over `<homeDir>/server.token`.
 *
 * The token is loaded (or generated) once at boot and reused across restarts.
 * `getToken()`/`isValid()` re-read the file whenever its mtime changes, so a
 * `kimi web rotate-token` (which rewrites the file) takes effect on a
 * running server immediately — no restart, no extra API. The file is small
 * (43 bytes) and the common path is a single `statSync` per check.
 *
 * `dispose()` is intentionally a no-op: the token must survive shutdown.
 */
export async function createTokenStore(homeDir: string, options: { readonly managed?: boolean } = {}): Promise<TokenStore> {
  const tokenPath = serverTokenPath(homeDir);
  const initial = await loadOrCreateServerToken(homeDir);
  const initialStat = statSync(tokenPath);
  let cache: { token: string; mtimeMs: number; ino: number } = {
    token: initial,
    mtimeMs: initialStat.mtimeMs,
    ino: initialStat.ino,
  };
  let generation = 0;
  let valid = true;

  const currentToken = (): string => {
    if (options.managed) {
      try {
        const st = statSync(tokenPath);
        if (!st.isFile() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) {
          throw new Error('server token file permissions are invalid');
        }
        const token = readFileSync(tokenPath, 'utf8').trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('server token file is invalid');
        if (!valid || token !== cache.token) generation += 1;
        valid = true;
        cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
        return token;
      } catch {
        if (valid) generation += 1;
        valid = false;
        return '';
      }
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(tokenPath);
    } catch {
      return cache.token;
    }
    if (st.mtimeMs === cache.mtimeMs && st.ino === cache.ino) return cache.token;
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return cache.token;
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token.length > 0) {
        if (token !== cache.token) generation += 1;
        cache = { token, mtimeMs: st.mtimeMs, ino: st.ino };
      }
    } catch {
    }
    return cache.token;
  };

  return {
    tokenPath,
    getToken: currentToken,
    generation(): number {
      currentToken();
      return generation;
    },
    isValid(candidate: string): boolean {
      const tokenBuf = Buffer.from(currentToken());
      const candidateBuf = Buffer.from(candidate);
      if (tokenBuf.length === 0 || candidateBuf.length !== tokenBuf.length) return false;
      return timingSafeEqual(candidateBuf, tokenBuf);
    },
    async dispose(): Promise<void> {
    },
  };
}
