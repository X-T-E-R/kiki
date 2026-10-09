import { randomUUID } from 'node:crypto';
import { Error2, ErrorCodes } from '#/errors';
import type { RawResponseObserver } from '#/kosong/contract/provider';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';

export interface AnthropicResponseCaptureInput {
  readonly sessionId: string;
  readonly agentId: string;
  readonly providerId: string;
  readonly model: string;
  readonly thinkingEffort: string;
  readonly expiresAt: number;
  readonly maxResponses: number;
}

export interface AnthropicResponseCaptureStatus {
  readonly captureId: string;
  readonly scope: string;
  readonly key: string;
  readonly filter: AnthropicResponseCaptureInput;
  readonly enabled: boolean;
  readonly responses: number;
  readonly completed: number;
  readonly bytes: number;
  readonly storageFailed: boolean;
  readonly flushed: boolean;
  readonly closedReason?: string;
}

export class AnthropicResponseCapture {
  private readonly captureId = randomUUID();
  private readonly key = `anthropic-response-${this.captureId}.jsonl`;
  private enabled = true;
  private responses = 0;
  private completed = 0;
  private bytes = 0;
  private storageFailed = false;
  private flushed = false;
  private revision = 0;
  private closedReason: string | undefined;
  private readonly active = new Map<string, () => void>();

  constructor(
    private readonly logs: IAppendLogStore,
    private readonly scope: string,
    private readonly filter: AnthropicResponseCaptureInput,
  ) {
    if (![filter.sessionId, filter.agentId, filter.providerId, filter.model, filter.thinkingEffort].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512) ||
      !Number.isFinite(filter.expiresAt) || filter.expiresAt <= Date.now() || filter.expiresAt > Date.now() + 7_200_000 ||
      !Number.isInteger(filter.maxResponses) || filter.maxResponses < 1 || filter.maxResponses > 100) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, 'Response capture requires exact identity, provider, model, effort, a future expiry within two hours, and 1–100 responses.');
    }
    this.append({ type: 'capture.start', captureId: this.captureId, filter, time: Date.now() });
  }

  observe(input: { providerId: string; model: string; thinkingEffort: string; protocol: string; turnId?: number; step?: number; cacheKey?: string }): RawResponseObserver | undefined {
    this.expire();
    if (!this.enabled || this.responses >= this.filter.maxResponses || input.protocol !== 'anthropic' ||
      input.providerId !== this.filter.providerId || input.model !== this.filter.model || input.thinkingEffort !== this.filter.thinkingEffort) return undefined;
    const attemptId = randomUUID();
    this.responses += 1;
    let ended = false;
    let bytes = 0;
    const end = (outcome: string): void => {
      if (ended) return;
      ended = true;
      this.active.delete(attemptId);
      this.completed += 1;
      this.append({ type: 'response.end', attemptId, outcome, bytes, time: Date.now() });
      if (this.responses >= this.filter.maxResponses && this.active.size === 0) this.stop('response-limit');
    };
    this.active.set(attemptId, () => end('capture-stopped'));
    this.append({ type: 'request', attemptId, ...input, time: Date.now() });
    return {
      start: (response) => {
        this.expire();
        if (ended) return;
        this.append({ type: 'response.start', attemptId, ...response, time: Date.now() });
      },
      chunk: (chunk) => {
        this.expire();
        if (ended || !this.enabled) return;
        if (bytes + chunk.byteLength > 8 * 1024 * 1024 || this.bytes + chunk.byteLength > 64 * 1024 * 1024) {
          end('byte-limit');
          this.stop('byte-limit');
          return;
        }
        bytes += chunk.byteLength;
        this.bytes += chunk.byteLength;
        this.append({ type: 'response.chunk', attemptId, base64: Buffer.from(chunk).toString('base64') });
      },
      end,
    };
  }

  stop(reason = 'operator'): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.closedReason = reason;
    for (const close of this.active.values()) close();
    this.append({ type: 'capture.stop', reason, time: Date.now() });
  }

  status(): AnthropicResponseCaptureStatus {
    this.expire();
    return { captureId: this.captureId, scope: this.scope, key: this.key, filter: { ...this.filter }, enabled: this.enabled,
      responses: this.responses, completed: this.completed, bytes: this.bytes, storageFailed: this.storageFailed, flushed: this.flushed, closedReason: this.closedReason };
  }

  async flush(): Promise<AnthropicResponseCaptureStatus> {
    this.expire();
    const revision = this.revision;
    try {
      await this.logs.flush(this.scope, this.key);
      this.flushed = !this.storageFailed && revision === this.revision;
    } catch {
      this.storageFailed = true;
      this.stop('storage-failed');
    }
    return this.status();
  }

  private expire(): void {
    if (Date.now() >= this.filter.expiresAt) this.stop('expired');
  }

  private append(record: unknown): void {
    if (this.storageFailed) return;
    this.flushed = false;
    this.revision += 1;
    try {
      this.logs.append(this.scope, this.key, record, { onError: () => { this.storageFailed = true; this.stop('storage-failed'); } });
    } catch {
      this.storageFailed = true;
      this.stop('storage-failed');
    }
  }
}
