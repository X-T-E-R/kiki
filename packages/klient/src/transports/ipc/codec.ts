/**
 * IPC wire framing — newline-delimited JSON over a `node:net` stream. One
 * socket multiplexes RPC `call`s and event `listen`s: `hello`/`call`/
 * `listen`/`unlisten` go out, `ready`/`result`/`error`/`listen_result`/
 * `event` come back.
 */

import { createHash } from 'node:crypto';

/** One NDJSON message. `type` discriminates; other fields depend on it. */
export interface IpcFrame {
  readonly type: string;
  readonly id?: string;
  readonly scope?: string;
  readonly service?: string;
  readonly method?: string;
  readonly arg?: unknown;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly event?: string;
  readonly token?: string;
  readonly code?: number;
  readonly msg?: string;
  readonly details?: unknown;
  readonly reason?: string;
  readonly data?: unknown;
}

export function normalizeIpcSocketPath(socketPath: string): string {
  if (process.platform !== 'win32' || socketPath.startsWith('\\\\.\\pipe\\')) return socketPath;
  const digest = createHash('sha256').update(socketPath).digest('hex').slice(0, 24);
  return `\\\\.\\pipe\\kimi-klient-${digest}`;
}

export function encodeFrame(frame: IpcFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Incremental NDJSON decoder; malformed lines are dropped. */
export class NdjsonDecoder {
  private buffer = '';

  push(chunk: string): IpcFrame[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const frames: IpcFrame[] = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line) as IpcFrame);
      } catch {
        // drop malformed frames
      }
    }
    return frames;
  }
}
