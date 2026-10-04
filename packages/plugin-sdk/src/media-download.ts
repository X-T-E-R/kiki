import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Stream one response to a staging file; failed transfers never replace an existing original. */
export async function downloadMedia(url: string, destination: string, options: { signal: AbortSignal; headers?: RequestInit['headers'] }): Promise<{ bytes: number }> {
  const response = await fetch(url, { signal: options.signal, headers: options.headers });
  if (!response.ok || response.body === null) throw new Error(`Media download failed (${response.status})`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part-${crypto.randomUUID()}`;
  try {
    const reader = response.body.getReader();
    const chunks = async function* () {
      try {
        for (;;) { const next = await reader.read(); if (next.done) return; yield next.value; }
      } finally { reader.releaseLock(); }
    };
    await pipeline(Readable.from(chunks()), createWriteStream(temporary, { flags: 'wx' }), { signal: options.signal });
    const bytes = (await stat(temporary)).size;
    const length = response.headers.get('content-length');
    if (bytes === 0 || (length !== null && !response.headers.has('content-encoding') && bytes !== Number(length))) throw new Error('Media download is empty or truncated');
    await rename(temporary, destination);
    return { bytes };
  } finally { await rm(temporary, { force: true }); }
}
