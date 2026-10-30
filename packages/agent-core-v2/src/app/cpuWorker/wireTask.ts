import { once } from 'node:events';
import { serialize } from 'node:v8';
import type { MessagePort } from 'node:worker_threads';
import { createWireContextProjection } from '#/agent/contextMemory/wireContextProjection';
import { AppendLogCorruptedError } from '#/persistence/interface/appendLogStore';
import type { WireRecord } from '#/wire/record';

export async function projectWireInput(input: MessagePort, scope: string, key: string): Promise<ArrayBuffer> {
  const projection = createWireContextProjection();
  const decoder = new TextDecoder();
  let pending = '';
  let lineNumber = 0;
  const parse = (raw: string, final: boolean): void => {
    lineNumber++;
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
  try {
    for (;;) {
      const incoming = once(input, 'message');
      input.postMessage({ pull: true }, []);
      const [message] = await incoming as [{ bytes?: ArrayBuffer; end?: boolean }];
      if (message.end) break;
      pending += decoder.decode(message.bytes, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        parse(pending.slice(0, newline), false);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.length > 0) parse(pending, true);
    return Uint8Array.from(serialize(projection.result())).buffer;
  } finally { input.close(); }
}
