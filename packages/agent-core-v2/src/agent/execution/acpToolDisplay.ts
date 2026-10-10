import type { NormalizedExecutorEvent } from '@kiki/protocol';
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
  const generic: ToolInputDisplay = { kind: 'generic', summary: tool.title };
  const input = objectOf(tool.rawInput);
  if (input?.['truncated'] === true || conflictingName(tool)) return generic;
  const locations = tool.locations ?? [];
  const path = locations.length > 1 ? undefined : stringOf(objectOf(locations[0])?.['path']) ?? firstString(input, ['filePath', 'filepath', 'file_path', 'path', 'target_file']);
  const diffs = tool.content?.filter((item) => objectOf(item)?.['type'] === 'diff') ?? [];
  if (diffs.length > 1) return generic;
  if (tool.kind === 'edit' && diffs.length === 1) {
    const diff = objectOf(diffs[0]);
    const diffPath = stringOf(diff?.['path']);
    const before = diff?.['oldText'];
    const after = stringOf(diff?.['newText']);
    if (diffPath !== undefined && after !== undefined && (before == null || typeof before === 'string')) {
      return { kind: 'diff', path: diffPath, before: before ?? '', after };
    }
    return generic;
  }
  const pattern = firstString(input, ['pattern', 'glob_pattern']);
  if ((tool.kind === 'read' || tool.kind === 'search') && pattern !== undefined) {
    return { kind: 'search', query: pattern, scope: firstString(input, ['path', 'target_directory']) };
  }
  if (tool.kind === 'read' && path !== undefined) return { kind: 'file_io', operation: 'read', path };
  if (tool.kind === 'edit' && path !== undefined) {
    const before = firstString(input, ['oldString', 'old_string']);
    const after = firstString(input, ['newString', 'new_string']);
    const content = stringOf(input?.['content']);
    if (content !== undefined && input?.['oldString'] === undefined && input?.['old_string'] === undefined) {
      return { kind: 'file_io', operation: 'write', path, content };
    }
    return { kind: 'file_io', operation: 'edit', path, before: after === undefined ? undefined : before, after: before === undefined ? undefined : after };
  }
  if (tool.kind === 'execute') {
    const command = firstString(input, ['command', 'cmd']);
    return command === undefined ? generic : { kind: 'command', command, cwd: firstString(input, ['workdir', 'cwd']) };
  }
  if (tool.kind === 'fetch') {
    const source = objectOf(input?.['source']);
    const url = stringOf(input?.['url']) ?? (source?.['kind'] === 'url' ? stringOf(source['url']) : undefined);
    if (url !== undefined) return { kind: 'url_fetch', url };
    const query = stringOf(input?.['query']);
    if (query !== undefined) return { kind: 'search', query };
  }
  if (tool.kind === 'search' && (input?.['variant'] === 'WebSearch' || input?.['variant'] === 'XSearch')) {
    const query = stringOf(input?.['query']);
    if (query !== undefined) return { kind: 'search', query };
  }
  return generic;
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

function conflictingName(tool: AcpToolState): boolean {
  const kinds: Record<string, readonly string[]> = {
    read: ['read'], grep: ['read', 'search'], glob: ['read', 'search'],
    edit: ['edit'], write: ['edit'], bash: ['execute'], shell: ['execute'],
    websearch: ['fetch', 'search'], xsearch: ['search'], fetchurl: ['fetch'], webfetch: ['fetch'],
  };
  const expected = tool.name === undefined ? undefined : kinds[tool.name.toLowerCase()];
  return expected !== undefined && !expected.includes(tool.kind ?? '');
}

export function acpContentText(content: readonly unknown[] | undefined): string {
  return (content ?? []).flatMap((item) => {
    const record = objectOf(item);
    const nested = objectOf(record?.['content']);
    const text = nested?.['type'] === 'text' ? stringOf(nested['text']) : record?.['type'] === 'text' ? stringOf(record['text']) : undefined;
    return text === undefined ? [] : [text];
  }).join('\n');
}

function firstString(input: Readonly<Record<string, unknown>> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = stringOf(input?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
