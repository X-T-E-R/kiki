import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';

import { buildDaemonFileUrl } from '#/agent/media/mediaRef';
import type { ISessionMediaStore } from '#/agent/media/sessionMediaStore';

export class PluginToolOutput {
  private transfer?: { stream: PassThrough; saved: Promise<string | undefined>; fileId: string; size: number; received: number };
  readonly references = new Set<string>();

  constructor(private readonly store: ISessionMediaStore | undefined, private readonly signal: AbortSignal) {}

  async request(action: unknown, input: unknown): Promise<unknown> {
    this.signal.throwIfAborted();
    if (action === 'start') {
      if (this.transfer !== undefined) throw new Error('A plugin output transfer is already active');
      if (this.store === undefined) throw new Error('Session attachment storage is unavailable; the tool output was not saved. Do not repeat the tool automatically.');
      const descriptor = input as { size?: unknown; mimeType?: unknown } | undefined;
      const size = descriptor?.size;
      const mimeType = descriptor?.mimeType;
      const extensions: Readonly<Record<string, string>> = { 'text/plain': 'txt', 'application/json': 'json', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || typeof mimeType !== 'string' || extensions[mimeType] === undefined) throw new Error('Invalid plugin output attachment');
      const fileId = `f_plugin_${randomUUID().replaceAll('-', '')}`;
      const stream = new PassThrough({ highWaterMark: 64 * 1024 });
      stream.on('error', () => {});
      const saved = this.store.materialize({ fileId, size, name: `output.${extensions[mimeType]}`, mimeType, stream: () => stream, signal: this.signal });
      this.transfer = { stream, saved, fileId, size, received: 0 };
      void saved.catch((error: unknown) => { stream.destroy(error instanceof Error ? error : new Error(String(error))); });
      return true;
    }
    const transfer = this.transfer;
    if (transfer === undefined) throw new Error('Plugin output transfer is not active');
    if (action === 'chunk') {
      if (typeof input !== 'string' || input.length > 64 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)) throw new Error('Invalid plugin output chunk');
      const bytes = Buffer.from(input, 'base64');
      if (bytes.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '') || transfer.received + bytes.length > transfer.size) throw new Error('Invalid plugin output chunk encoding or size');
      transfer.received += bytes.length;
      await new Promise<void>((resolve, reject) => {
        transfer.stream.write(bytes, (error) => { if (error) reject(transfer.stream.errored ?? error); else resolve(); });
      });
      return true;
    }
    if (action === 'end') {
      if (transfer.received !== transfer.size) throw new Error('Plugin output attachment is incomplete');
      transfer.stream.end();
      const path = await transfer.saved;
      this.transfer = undefined;
      if (path === undefined) throw new Error('Session attachment storage did not save the plugin output. Do not repeat the tool automatically.');
      const reference = buildDaemonFileUrl(transfer.fileId);
      this.references.add(reference);
      return { path, reference, size: transfer.size };
    }
    throw new Error('Unsupported plugin output transfer action');
  }

  async dispose(): Promise<void> {
    const transfer = this.transfer;
    this.transfer = undefined;
    transfer?.stream.destroy(new Error('Plugin output reception stopped'));
    await transfer?.saved.catch(() => undefined);
  }
}
