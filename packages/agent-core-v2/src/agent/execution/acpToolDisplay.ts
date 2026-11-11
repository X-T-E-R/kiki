import { projectExternalToolDisplay, type NormalizedExecutorEvent } from '@kiki/protocol';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export type AcpToolEvent = Extract<NormalizedExecutorEvent, { type: 'tool.call' | 'tool.update' }>;

export interface AcpToolState {
  title: string;
  syntheticLabel: boolean;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: readonly unknown[];
  locations?: readonly unknown[];
  text: string;
}

export function mergeAcpToolState(previous: AcpToolState | undefined, event: AcpToolEvent): AcpToolState {
  const content = event.content?.length ? event.content : previous?.content;
  const rawOutput = (event.rawOutput === undefined || event.rawOutput === null || event.rawOutput === '') && previous?.rawOutput !== undefined ? previous.rawOutput : event.rawOutput;
  const text = acpContentText(content) || extractRawOutputText(rawOutput) || previous?.text || '';
  return {
    title: event.title ?? previous?.title ?? event.kind ?? 'External tool',
    syntheticLabel: event.title === undefined && (previous?.syntheticLabel ?? true),
    name: event.name ?? previous?.name,
    kind: event.kind ?? previous?.kind,
    status: event.status ?? previous?.status,
    rawInput: event.rawInput === undefined ? previous?.rawInput : event.rawInput,
    rawOutput,
    content,
    locations: event.locations ?? previous?.locations,
    text,
  };
}

export function acpToolDisplay(tool: AcpToolState): ToolInputDisplay {
  return projectExternalToolDisplay({
    name: tool.name,
    title: tool.title,
    kind: tool.kind,
    rawInput: tool.rawInput,
    content: tool.content,
    locations: tool.locations,
    summary: tool.title,
  });
}

export function acpToolOutput(tool: AcpToolState, remoteSessionId: string, remoteToolCallId: string) {
  const contentMedia = (tool.content ?? []).flatMap((item) => {
    const record = objectOf(item);
    if (record === undefined) return [];
    const block = record['type'] === 'content'
      ? objectOf(record['content'])
      : record['type'] === 'image'
        ? record
        : undefined;
    if (block?.['type'] !== 'image' || typeof block['mimeType'] !== 'string' || typeof block['data'] !== 'string') return [];
    return [{ type: 'image' as const, source: { kind: 'base64' as const, media_type: block['mimeType'], data: block['data'] } }];
  });
  const rawMedia = extractRawOutputMedia(tool.rawOutput);
  const media = contentMedia.length > 0 ? contentMedia : rawMedia;
  return {
    kind: 'external_tool_output' as const,
    protocol: 'acp-v1' as const,
    remoteSessionId,
    remoteToolCallId,
    title: tool.title,
    syntheticLabel: tool.syntheticLabel,
    name: tool.name,
    toolKind: tool.kind,
    status: tool.status,
    rawInput: tool.rawInput,
    rawOutput: tool.rawOutput,
    content: tool.content,
    locations: tool.locations,
    text: tool.text,
    media,
  };
}

export function acpContentText(content: readonly unknown[] | undefined): string {
  return (content ?? []).flatMap((item) => {
    const record = objectOf(item);
    if (record === undefined) return [];
    const nested = record['type'] === 'content' ? objectOf(record['content']) : undefined;
    const text = nested?.['type'] === 'text' ? stringOf(nested['text']) : record['type'] === 'text' ? stringOf(record['text']) : undefined;
    return text === undefined ? [] : [text];
  }).join('\n');
}

function extractRawOutputText(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput;
  const rec = objectOf(rawOutput);
  if (rec === undefined) return '';
  for (const key of ['text', 'output_for_prompt', 'stdout', 'output', 'content']) {
    const val = rec[key];
    if (typeof val === 'string' && val.length > 0) return val;
    const bytesText = decodeByteArray(val);
    if (bytesText !== undefined) return bytesText;
  }
  const nestedResult = objectOf(rec['Result'] ?? rec['result']);
  if (nestedResult !== undefined) {
    for (const key of ['output', 'text', 'stdout']) {
      const val = nestedResult[key];
      if (typeof val === 'string' && val.length > 0) return val;
      const bytesText = decodeByteArray(val);
      if (bytesText !== undefined) return bytesText;
    }
  }
  return '';
}

function decodeByteArray(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 262_144) return undefined;
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255) return undefined;
  }
  return Buffer.from(value).toString('utf8');
}

function extractRawOutputMedia(rawOutput: unknown): { readonly type: 'image'; readonly source: { readonly kind: 'base64'; readonly media_type: string; readonly data: string } }[] {
  const rec = objectOf(rawOutput);
  const files = Array.isArray(rec?.['files']) ? rec['files'] : Array.isArray(rec?.['attachments']) ? rec['attachments'] : [];
  return files.flatMap((entry) => {
    const file = objectOf(entry);
    const url = stringOf(file?.['url'] ?? file?.['dataUrl']);
    if (url !== undefined) {
      const parsed = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
      if (parsed?.[1] && parsed[2]) {
        return [{
          type: 'image' as const,
          source: { kind: 'base64' as const, media_type: parsed[1].toLowerCase(), data: parsed[2].replaceAll(/\s/g, '') },
        }];
      }
    }
    if (file?.['type'] === 'image' && typeof file['mimeType'] === 'string' && typeof file['data'] === 'string') {
      return [{
        type: 'image' as const,
        source: { kind: 'base64' as const, media_type: file['mimeType'], data: file['data'] },
      }];
    }
    return [];
  });
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
