import type { SessionEventFrame } from '../lib/types';

export interface FrameBufferOptions {
  readonly maxFrames?: number;
  readonly maxBytes?: number;
}

export interface FrameBufferPushResult {
  readonly accepted: boolean;
  readonly overflowed: boolean;
}

const DEFAULT_MAX_FRAMES = Number.POSITIVE_INFINITY;
const DEFAULT_MAX_BYTES = Number.POSITIVE_INFINITY;

function emittingAgent(frame: SessionEventFrame): string {
  return (frame.payload as { agentId?: string }).agentId ?? 'main';
}

/** Coalescing is deliberately limited to volatile payloads whose merge rules
 * preserve the reducer's cumulative-offset contract. Durable frames are never
 * merged and therefore remain strict ordering barriers. */
export function volatileFrameKey(frame: SessionEventFrame): string | undefined {
  if (frame.volatile !== true) return undefined;
  const payload = frame.payload as SessionEventFrame['payload'] & {
    turnId?: string | number;
    toolCallId?: string;
    commandId?: string;
  };
  const prefix = `${frame.session_id ?? ''}:${emittingAgent(frame)}`;
  // Intentional partial router: only coalescible volatile payloads get keys;
  // the default case declines everything else.
  // eslint-disable-next-line typescript/switch-exhaustiveness-check
  switch (payload.type) {
    case 'assistant.delta':
      return `${prefix}:turn:${String(payload.turnId)}:assistant`;
    case 'thinking.delta':
      return `${prefix}:turn:${String(payload.turnId)}:thinking`;
    case 'tool.call.delta':
      return payload.toolCallId === undefined ? undefined : `${prefix}:tool:${payload.toolCallId}:args`;
    case 'tool.progress':
      return payload.toolCallId === undefined ? undefined : `${prefix}:tool:${payload.toolCallId}:progress`;
    case 'shell.output':
      return payload.commandId === undefined ? undefined : `${prefix}:shell:${payload.commandId}:output`;
    default:
      return undefined;
  }
}

function deltaLength(frame: SessionEventFrame): number {
  const payload = frame.payload as { type: string; delta?: string };
  return payload.type === 'assistant.delta' || payload.type === 'thinking.delta'
    ? (payload.delta?.length ?? 0)
    : 0;
}

export function mergeVolatileFrames(
  previous: SessionEventFrame,
  incoming: SessionEventFrame,
): SessionEventFrame | undefined {
  const previousKey = volatileFrameKey(previous);
  if (previousKey === undefined || previousKey !== volatileFrameKey(incoming)) return undefined;
  const a = previous.payload as SessionEventFrame['payload'] & {
    delta?: string;
    name?: string;
    argumentsPart?: string;
    update?: { text?: string; [key: string]: unknown };
  };
  const b = incoming.payload as typeof a;
  // Intentional partial router: only the mergeable volatile kinds have cases;
  // the default case refuses to merge everything else.
  // eslint-disable-next-line typescript/switch-exhaustiveness-check
  switch (a.type) {
    case 'assistant.delta':
    case 'thinking.delta': {
      const expectedOffset =
        previous.offset === undefined ? undefined : previous.offset + deltaLength(previous);
      if (incoming.offset !== undefined && expectedOffset !== incoming.offset) return undefined;
      return {
        ...incoming,
        offset: previous.offset,
        payload: { ...b, delta: `${a.delta ?? ''}${b.delta ?? ''}` } as SessionEventFrame['payload'],
      };
    }
    case 'tool.call.delta':
      return {
        ...incoming,
        payload: {
          ...b,
          name: b.name ?? a.name,
          argumentsPart: `${a.argumentsPart ?? ''}${b.argumentsPart ?? ''}`,
        } as SessionEventFrame['payload'],
      };
    case 'tool.progress':
      return incoming;
    case 'shell.output':
      return {
        ...incoming,
        payload: {
          ...b,
          update: { ...a.update, ...b.update, text: `${a.update?.text ?? ''}${b.update?.text ?? ''}` },
        } as SessionEventFrame['payload'],
      };
    default:
      return undefined;
  }
}

function estimateFrameBytes(frame: SessionEventFrame): number {
  try {
    return JSON.stringify(frame).length * 2;
  } catch {
    return 1024;
  }
}

/** Ordered queue with consecutive-run volatile coalescing. A different key or
 * any durable frame closes the current run, preserving original wire order. */
export class FrameBuffer {
  private frames: SessionEventFrame[] = [];
  private bytes = 0;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(options: FrameBufferOptions = {}) {
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get length(): number {
    return this.frames.length;
  }

  get approximateBytes(): number {
    return this.bytes;
  }

  push(frame: SessionEventFrame): FrameBufferPushResult {
    const last = this.frames.at(-1);
    const merged = last === undefined ? undefined : mergeVolatileFrames(last, frame);
    if (merged !== undefined) {
      this.frames[this.frames.length - 1] = merged;
    } else {
      this.frames.push(frame);
    }
    // Additive accounting only: merged frames grow by the incoming frame's
    // contribution, so re-serializing the merged frame here would make a long
    // same-key burst quadratic in stringify work (measured as event-loop lag
    // in the burst proof). Slight overcount of envelope overhead is fine for
    // a safety cap.
    this.bytes += estimateFrameBytes(frame);
    if (this.frames.length > this.maxFrames || this.bytes > this.maxBytes) {
      this.clear();
      return { accepted: false, overflowed: true };
    }
    return { accepted: true, overflowed: false };
  }

  drain(): SessionEventFrame[] {
    const frames = this.frames;
    this.frames = [];
    this.bytes = 0;
    return frames;
  }

  clear(): void {
    this.frames = [];
    this.bytes = 0;
  }
}
