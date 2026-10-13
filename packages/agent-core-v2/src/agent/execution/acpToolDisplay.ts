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
  const text = acpContentText(content) || (typeof rawOutput === 'string' ? rawOutput : '') || previous?.text || '';
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
  const media = (tool.content ?? []).flatMap((item) => {
    const record = objectOf(item);
    const block = record?.['type'] === 'content' ? objectOf(record['content']) : undefined;
    if (block?.['type'] !== 'image' || typeof block['mimeType'] !== 'string' || typeof block['data'] !== 'string') return [];
    return [{ type: 'image' as const, source: { kind: 'base64' as const, media_type: block['mimeType'], data: block['data'] } }];
  });
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
    const nested = objectOf(record?.['content']);
    const text = nested?.['type'] === 'text' ? stringOf(nested['text']) : record?.['type'] === 'text' ? stringOf(record['text']) : undefined;
    return text === undefined ? [] : [text];
  }).join('\n');
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
