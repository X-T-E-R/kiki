import type { SSHKaos } from '@kiki/kaos/ssh';
import type { KaosProcess } from '@kiki/kaos';
import { StringDecoder } from 'node:string_decoder';
import { decodeTextWithErrors, type TextDecodeErrors } from '#/_base/execEnv/decodeText';
import { abortable, createDeadlineAbortSignal } from '#/_base/utils/abort';

const CHUNK_SIZE = 64 * 1024;

export interface SshLineOptions {
  readonly encoding?: BufferEncoding;
  readonly errors?: TextDecodeErrors;
  readonly signal?: AbortSignal;
}

function decoder(options: SshLineOptions, offset: number): (chunk?: Buffer) => string {
  const encoding = options.encoding ?? 'utf-8';
  const errors = options.errors ?? 'strict';
  const utf8 = encoding === 'utf8' || encoding === 'utf-8';
  const utf16 = ['utf16le', 'ucs2', 'ucs-2'].includes(encoding);
  if (errors === 'ignore' && (utf8 || utf16)) {
    let pending = Buffer.alloc(0);
    return (chunk) => {
      const bytes = chunk === undefined ? pending : Buffer.concat([pending, chunk]);
      let end = bytes.length;
      if (chunk !== undefined) {
        if (utf8) {
          let lead = bytes.length - 1;
          while (lead >= 0 && bytes[lead]! >= 0x80 && bytes[lead]! <= 0xbf && lead >= bytes.length - 3) lead--;
          const byte = bytes[lead];
          const width = byte === undefined ? 0 : byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
          if (lead >= 0 && bytes.length - lead < width) end = lead;
        } else {
          end -= end % 2;
          if (end >= 2) {
            const last = bytes.readUInt16LE(end - 2);
            if (last >= 0xd800 && last <= 0xdbff) end -= 2;
          }
        }
      }
      pending = Buffer.from(bytes.subarray(end));
      return decodeTextWithErrors(bytes.subarray(0, end), encoding, errors, offset !== 0);
    };
  }
  if (utf8 || utf16) {
    const value = new TextDecoder(utf8 ? 'utf-8' : 'utf-16le', { fatal: errors === 'strict', ignoreBOM: offset !== 0 });
    return (chunk) => value.decode(chunk, { stream: chunk !== undefined });
  }
  const value = new StringDecoder(encoding);
  return (chunk) => chunk === undefined ? value.end() : value.write(chunk);
}

export async function* readSshLineRange(
  ssh: SSHKaos,
  path: string,
  options: SshLineOptions & { readonly startLine?: number; readonly maxLines?: number; readonly startByte?: number; readonly endByte?: number },
): AsyncGenerator<string> {
  const startLine = Math.max(1, options.startLine ?? 1);
  const maxLines = Math.max(0, options.maxLines ?? Number.POSITIVE_INFINITY);
  if (maxLines === 0) return;
  const utf8 = options.encoding === undefined || options.encoding === 'utf8' || options.encoding === 'utf-8';
  let skipped = 1;
  let yielded = 0;
  let pending = '';
  let decode: ReturnType<typeof decoder> | undefined;
  let byteOffset = options.startByte ?? 0;
  for await (const chunk of ssh.readByteStream(path, { start: byteOffset, end: options.endByte, signal: options.signal })) {
    let from = 0;
    if (utf8) {
      while (skipped < startLine) {
        const newline = chunk.indexOf(10, from);
        if (newline < 0) { from = chunk.length; break; }
        skipped++;
        from = newline + 1;
      }
    }
    if (from < chunk.length) {
      decode ??= decoder(options, byteOffset + from);
      let end = chunk.length;
      if (utf8) {
        let remaining = maxLines - yielded;
        for (let newline = chunk.indexOf(10, from); newline >= 0; newline = chunk.indexOf(10, newline + 1)) {
          if (--remaining === 0) { end = newline + 1; break; }
        }
      }
      pending += decode(chunk.subarray(from, end));
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (!utf8 && skipped++ < startLine) continue;
        yield line;
        if (++yielded >= maxLines) return;
      }
    }
    byteOffset += chunk.length;
  }
  pending += decode?.() ?? '';
  if (pending.length > 0 && skipped >= startLine) yield pending;
}

async function countRemoteNewlines(ssh: SSHKaos, path: string, signal?: AbortSignal): Promise<number> {
  const deadline = createDeadlineAbortSignal(signal ?? new AbortController().signal, 10_000);
  let process: KaosProcess | undefined;
  const launch = Promise.resolve().then(() => ssh.osEnv.osKind === 'Windows'
    ? ssh.execPowerShell(`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString('base64')}')); $s=[IO.File]::OpenRead($p); try { $b=[byte[]]::new(65536); $count=[long]0; while (($n=$s.Read($b,0,$b.Length)) -gt 0) { for ($i=[Array]::IndexOf($b,[byte]10,0,$n); $i -ge 0; $i=[Array]::IndexOf($b,[byte]10,$i+1,$n-$i-1)) { $count++ } }; [Console]::WriteLine($count) } finally { $s.Dispose() }`)
    : ssh.execWithEnv(['sh', '-c', 'wc -l < "$1"', 'kiki-line-count', path]));
  try {
    process = await abortable(launch, deadline.signal);
    process.stdin.end();
    const read = async (): Promise<string> => {
      let output = '';
      process!.stderr.resume();
      for await (const chunk of process!.stdout) {
        output += String(chunk);
        if (output.length > 128) throw new Error('Invalid remote line count');
      }
      if (await process!.wait() !== 0 || !/^\s*\d+\s*$/.test(output)) throw new Error('Remote line count failed');
      return output;
    };
    const count = Number(await abortable(read(), deadline.signal));
    if (!Number.isSafeInteger(count)) throw new Error('Invalid remote line count');
    return count;
  } finally {
    deadline.clear();
    if (process !== undefined) await process.dispose();
    else void launch.then(async (late) => { await late.dispose(); }).catch(() => {});
  }
}

export async function locateSshTail(ssh: SSHKaos, path: string, options: SshLineOptions & { readonly tailLines: number }): Promise<{ startByte: number; startLine: number; totalLines: number; size: number; mtime: number }> {
  const { tailLines, signal } = options;
  signal?.throwIfAborted();
  const stat = await ssh.stat(path);
  let newlineCount: number;
  try { newlineCount = await countRemoteNewlines(ssh, path, signal); } catch {
    signal?.throwIfAborted();
    newlineCount = 0;
    for await (const chunk of ssh.readByteStream(path, { signal })) {
      for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, newline + 1)) newlineCount++;
    }
  }
  let offset = stat.stSize;
  let hasContent = stat.stSize > 0;
  let finalNewline = false;
  let needed = tailLines;
  let startByte = 0;
  while (offset > 0) {
    signal?.throwIfAborted();
    const start = Math.max(0, offset - CHUNK_SIZE);
    const chunks: Buffer[] = [];
    for await (const chunk of ssh.readByteStream(path, { start, end: offset - 1, signal })) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (offset === stat.stSize) {
      finalNewline = bytes.at(-1) === 10;
      if (stat.stSize === 3 && options.errors !== 'ignore' && bytes.equals(Buffer.from([0xef, 0xbb, 0xbf]))) hasContent = false;
      if (finalNewline) needed++;
    }
    for (let newline = bytes.lastIndexOf(10); newline >= 0; newline = bytes.lastIndexOf(10, newline - 1)) {
      if (--needed === 0) { startByte = start + newline + 1; break; }
      if (newline === 0) break;
    }
    if (needed === 0) break;
    offset = start;
  }
  const totalLines = newlineCount + (hasContent && !finalNewline ? 1 : 0);
  const current = await ssh.stat(path);
  if (current.stSize !== stat.stSize || current.stMtime !== stat.stMtime) throw new Error('SSH file changed while locating the requested line window. Retry the read.');
  return { startByte, startLine: Math.max(1, totalLines - tailLines + 1), totalLines, size: stat.stSize, mtime: stat.stMtime };
}
