import type { MediaJob } from '../../lib/mediaSources';

export interface MediaJobDeliveryChannel {
  readonly channel_id?: string;
  readonly channelId?: string;
  readonly status?: string;
  readonly unsupported?: readonly string[];
  readonly detail?: string;
}

export interface MediaJobDeliveryMessage {
  readonly index?: number;
  readonly message_id?: string;
  readonly delivery?: string;
  readonly detail?: string;
  readonly channels?: readonly MediaJobDeliveryChannel[];
  readonly attachments?: readonly unknown[];
}

export interface MediaJobDelivery {
  readonly status?: string;
  readonly delivery?: string;
  readonly request_id?: string;
  readonly message_id?: string;
  readonly detail?: string;
  readonly channels?: readonly MediaJobDeliveryChannel[];
  readonly attachments?: readonly unknown[];
  readonly messages?: readonly MediaJobDeliveryMessage[];
}

export interface ParsedMediaJobResult {
  readonly job: MediaJob;
  readonly delivery?: MediaJobDelivery;
}

function extractMediaPayloadCandidates(output: unknown): Record<string, unknown>[] {
  if (output === null || output === undefined) return [];
  if (typeof output === 'object') {
    if (Array.isArray(output)) {
      const candidates: Record<string, unknown>[] = [];
      for (const part of output) {
        if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text') {
          const text = (part as { text?: unknown }).text;
          if (typeof text === 'string') {
            candidates.push(...extractMediaPayloadCandidates(text));
          }
        }
      }
      return candidates;
    }
    return [output as Record<string, unknown>];
  }
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return [parsed as Record<string, unknown>];
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parseMediaDeliveryChannels(rawList: unknown): MediaJobDeliveryChannel[] | undefined {
  if (!Array.isArray(rawList)) return undefined;
  return rawList.map((ch) => {
    if (typeof ch !== 'object' || ch === null) return {};
    const c = ch as Record<string, unknown>;
    return {
      channel_id: typeof c['channel_id'] === 'string' ? c['channel_id'] : undefined,
      channelId: typeof c['channelId'] === 'string' ? c['channelId'] : typeof c['channel_id'] === 'string' ? c['channel_id'] : undefined,
      status: typeof c['status'] === 'string' ? c['status'] : undefined,
      unsupported: Array.isArray(c['unsupported']) ? c['unsupported'].filter((s): s is string => typeof s === 'string') : undefined,
      detail: typeof c['detail'] === 'string' ? c['detail'] : undefined,
    };
  });
}

function parseMediaDelivery(value: unknown): MediaJobDelivery | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const rawMessages = Array.isArray(raw['messages']) ? raw['messages'] : undefined;
  const isBatch = rawMessages !== undefined && rawMessages.length > 0;

  if (isBatch) {
    const messages: MediaJobDeliveryMessage[] = rawMessages.map((item, idx) => {
      if (typeof item !== 'object' || item === null) return { index: idx, delivery: 'unknown' };
      const m = item as Record<string, unknown>;
      return {
        index: typeof m['index'] === 'number' ? m['index'] : idx,
        message_id: typeof m['message_id'] === 'string' ? m['message_id'] : undefined,
        delivery: typeof m['delivery'] === 'string' ? m['delivery'] : 'unknown',
        detail: typeof m['detail'] === 'string' ? m['detail'] : undefined,
        channels: parseMediaDeliveryChannels(m['channels']),
        attachments: Array.isArray(m['attachments']) ? m['attachments'] : undefined,
      };
    });

    return {
      status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
      delivery: typeof raw['delivery'] === 'string' ? raw['delivery'] : undefined,
      request_id: typeof raw['request_id'] === 'string' ? raw['request_id'] : undefined,
      message_id: typeof raw['message_id'] === 'string' ? raw['message_id'] : undefined,
      detail: typeof raw['detail'] === 'string' ? raw['detail'] : undefined,
      messages,
      attachments: Array.isArray(raw['attachments']) ? raw['attachments'] : undefined,
    };
  }

  const channels = parseMediaDeliveryChannels(raw['channels']);

  return {
    status: typeof raw['status'] === 'string' ? raw['status'] : undefined,
    delivery: typeof raw['delivery'] === 'string' ? raw['delivery'] : undefined,
    request_id: typeof raw['request_id'] === 'string' ? raw['request_id'] : undefined,
    message_id: typeof raw['message_id'] === 'string' ? raw['message_id'] : undefined,
    detail: typeof raw['detail'] === 'string' ? raw['detail'] : undefined,
    channels,
    attachments: Array.isArray(raw['attachments']) ? raw['attachments'] : undefined,
  };
}

function parseMediaJob(value: unknown): MediaJob | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const job = value as Record<string, unknown>;
  if (typeof job['job_id'] !== 'string' || typeof job['state'] !== 'string' || !Array.isArray(job['artifacts'])) return undefined;
  return value as MediaJob;
}

export function readMediaJobResult(output: unknown): ParsedMediaJobResult | undefined {
  const candidates = extractMediaPayloadCandidates(output);
  for (const candidate of candidates) {
    if (candidate['type'] === 'media_generation') {
      const job = parseMediaJob(candidate['job']);
      if (job !== undefined) {
        const delivery = parseMediaDelivery(candidate['delivery']);
        return { job, delivery };
      }
    }
  }
  return undefined;
}

export function readMediaJobFromToolResult(output: unknown): MediaJob | undefined {
  return readMediaJobResult(output)?.job;
}

export function hasMediaJob(output: unknown): boolean {
  return readMediaJobFromToolResult(output) !== undefined;
}
