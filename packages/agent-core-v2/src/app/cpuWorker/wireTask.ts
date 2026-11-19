import { once } from 'node:events';
import { serialize } from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import { createWireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import { AppendLogCorruptedError } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';

export async function* decodeWireInput(input: MessagePort, signal?: AbortSignal): AsyncIterable<string> {
  const decoder = new TextDecoder();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const incoming = once(input, 'message', signal === undefined ? undefined : { signal });
      input.postMessage({ pull: true }, []);
      const [message] = await incoming as [{ bytes?: ArrayBuffer; end?: boolean; abort?: boolean }];
      if (message.abort) throw signal?.reason ?? new DOMException('CPU stream cancelled', 'AbortError');
      if (message.end) break;
      signal?.throwIfAborted();
      yield decoder.decode(message.bytes, { stream: true });
    }
    signal?.throwIfAborted();
    yield decoder.decode();
  } finally { input.close(); }
}

export async function projectWireInput(
  input: MessagePort,
  scope: string,
  key: string,
  omitTranscript = false,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const projection = createWireContextProjection();
  let pending = '';
  let lineNumber = 0;
  const parse = (raw: string, final: boolean): void => {
    lineNumber++;
    if ((lineNumber & 63) === 0) signal?.throwIfAborted();
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length === 0) return;
    let record: WireRecord;
    try { record = JSON.parse(line) as WireRecord; }
    catch (error) {
      if (final) return;
      throw new AppendLogCorruptedError(scope, key, lineNumber, error);
    }
    projection.add(record);
  };
  for await (const text of decodeWireInput(input, signal)) {
    signal?.throwIfAborted();
    pending += text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      parse(pending.slice(0, newline), false);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  signal?.throwIfAborted();
  if (pending.length > 0) parse(pending, true);
  signal?.throwIfAborted();
  const resolved = projection.result();
  if (omitTranscript) {
    const { transcript: _transcript, ...statusOnly } = resolved;
    return Uint8Array.from(serialize(statusOnly)).buffer;
  }
  return Uint8Array.from(serialize(resolved)).buffer;
}
