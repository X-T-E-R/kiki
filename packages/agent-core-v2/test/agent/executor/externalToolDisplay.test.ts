import { describe, expect, it } from 'vitest';
import { externalToolDisplay } from '#/agent/execution/externalTurnRecorder';
import { acpToolDisplay, acpToolOutput, mergeAcpToolState, type AcpToolEvent } from '#/agent/execution/acpToolDisplay';

const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } });
const diff = (path: string, oldText: string | null, newText: string) => ({ type: 'diff', path, oldText, newText });
const base = { type: 'tool.call' as const, toolCallId: 'remote-call', title: 'Tool' };
const cases: { id: string; event: Partial<AcpToolEvent>; display: object }[] = [
  { id: 'pos-read-location', event: { kind: 'read', rawInput: { filePath: 'src/main.ts' }, locations: [{ path: '/work/src/main.ts', line: 10 }] }, display: { kind: 'file_io', operation: 'read', path: '/work/src/main.ts' } },
  { id: 'pos-read-kimi-path', event: { kind: 'read', rawInput: { path: 'src/main.ts', line_offset: 1, n_lines: 100 } }, display: { kind: 'file_io', operation: 'read', path: 'src/main.ts' } },
  { id: 'pos-diff-v1', event: { kind: 'edit', content: [diff('/work/a.ts', 'old', 'new')] }, display: { kind: 'diff', path: '/work/a.ts', before: 'old', after: 'new' } },
  { id: 'pos-write-whole-file', event: { kind: 'edit', rawInput: { filePath: '/work/new.ts', content: 'export {}\n' } }, display: { kind: 'file_io', operation: 'write', path: '/work/new.ts', content: 'export {}\n' } },
  { id: 'pos-edit-snake-args-without-diff', event: { kind: 'edit', rawInput: { path: '/work/a.ts', old_string: 'a', new_string: 'b' } }, display: { kind: 'file_io', operation: 'edit', path: '/work/a.ts', before: 'a', after: 'b' } },
  { id: 'pos-execute-command', event: { kind: 'execute', rawInput: { command: 'npm test', workdir: '/work' } }, display: { kind: 'command', command: 'npm test', cwd: '/work' } },
  { id: 'pos-execute-cmd-alias', event: { kind: 'execute', rawInput: { cmd: 'pwd' } }, display: { kind: 'command', command: 'pwd' } },
  { id: 'pos-search-pattern', event: { kind: 'search', rawInput: { pattern: 'toolCallId', path: '/work/src', include: '*.ts' } }, display: { kind: 'search', query: 'toolCallId', scope: '/work/src' } },
  { id: 'pos-kimi-read-kind-is-grep', event: { kind: 'read', rawInput: { pattern: 'toolCallId', path: 'src', glob: '*.ts' } }, display: { kind: 'search', query: 'toolCallId', scope: 'src' } },
  { id: 'pos-fetch-url', event: { kind: 'fetch', rawInput: { url: 'https://example.com/spec' } }, display: { kind: 'url_fetch', url: 'https://example.com/spec' } },
  { id: 'pos-kimi-websearch-kind-fetch', event: { kind: 'fetch', rawInput: { query: 'acp tool kind' } }, display: { kind: 'search', query: 'acp tool kind' } },
  { id: 'pos-grok-websearch-variant', event: { kind: 'search', rawInput: { query: 'acp', variant: 'WebSearch' } }, display: { kind: 'search', query: 'acp' } },
  { id: 'neg-title-as-command', event: { title: 'Execute `npm test`', kind: 'execute' }, display: { kind: 'generic', summary: 'Execute `npm test`' } },
  { id: 'neg-title-bash-not-shellblock', event: { title: 'Bash', kind: 'execute', rawInput: { command: 'ls' } }, display: { kind: 'command', command: 'ls' } },
  { id: 'neg-native-name-semantics', event: { title: 'WebSearch', name: 'WebSearch', kind: 'other', rawInput: { query: 'acp' } }, display: { kind: 'generic', summary: 'WebSearch' } },
  { id: 'neg-kind-name-conflict', event: { title: 'grep', name: 'grep', kind: 'execute', rawInput: { pattern: 'x', command: 'rg x' } }, display: { kind: 'generic', summary: 'grep' } },
  { id: 'neg-opencode-websearch-kind-other', event: { title: 'Exa: acp diff', kind: 'other', rawInput: { query: 'acp diff' } }, display: { kind: 'generic', summary: 'Exa: acp diff' } },
  { id: 'neg-snake-diff-not-v1', event: { title: 'edit', kind: 'edit', content: [{ type: 'diff', path: '/work/a.ts', old_text: 'old', new_text: 'new' }] }, display: { kind: 'generic', summary: 'edit' } },
  { id: 'neg-multi-diff', event: { kind: 'edit', content: [diff('/work/a.ts', 'a', 'b'), diff('/work/b.ts', 'c', 'd')] }, display: { kind: 'generic', summary: 'Tool' } },
  { id: 'neg-new-file-null-oldText', event: { kind: 'edit', content: [diff('/work/new.ts', null, 'export {}\n')] }, display: { kind: 'diff', path: '/work/new.ts', before: '', after: 'export {}\n' } },
];

describe('ACP tool timeline display mapping', () => {
  it.each(cases)('$id', ({ event, display }) => {
    const source = { ...base, ...event } as AcpToolEvent;
    const state = mergeAcpToolState(undefined, source);
    expect(acpToolDisplay(state)).toEqual(display);
    expect(acpToolOutput(state, 'remote-session', source.toolCallId)).toMatchObject({
      remoteSessionId: 'remote-session', remoteToolCallId: source.toolCallId,
      rawInput: source.rawInput, rawOutput: source.rawOutput, content: source.content, locations: source.locations,
    });
  });

  it('pos-image-content', () => {
    const content = [text('image attached'), { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } }];
    const state = mergeAcpToolState(undefined, { ...base, kind: 'read', rawInput: { filePath: '/work/shot.png' }, content });
    expect(acpToolDisplay(state)).toEqual({ kind: 'file_io', operation: 'read', path: '/work/shot.png' });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ content, text: 'image attached', media: [{ type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] });
  });

  it('preserves unknown image-shaped content without inventing media', () => {
    const content = [{ type: 'future', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } }];
    const state = mergeAcpToolState(undefined, { ...base, content });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ content, media: [] });
  });

  it('pos-terminal-ref', () => {
    const content = [{ type: 'terminal', terminalId: 'term-9' }];
    const state = mergeAcpToolState(undefined, { ...base, kind: 'execute', rawInput: { command: 'npm test' }, content });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ content, text: '', media: [] });
    expect(acpToolDisplay(state)).toEqual({ kind: 'command', command: 'npm test' });
  });

  it('pos-failed-with-text-and-raw', () => {
    const rawOutput = { error: 'exit 1', metadata: { kept: true } };
    const state = mergeAcpToolState(undefined, { ...base, status: 'failed', content: [text('exit 1')], rawOutput });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ status: 'failed', text: 'exit 1', rawOutput });
  });

  it('neg-cancelled-not-failed', () => {
    const state = mergeAcpToolState(undefined, { ...base, status: 'cancelled', content: [text('partial')] });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ status: 'cancelled', text: 'partial' });
  });

  it('neg-unknown-tool-kept', () => {
    const source = { ...base, kind: 'other', rawInput: { widget: { id: 7 }, extra: [1, { k: 'v' }] }, rawOutput: { ok: false, detail: { reason: 'nope' } }, content: [{ type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' } }, { type: 'future', value: { kept: true } }], locations: [{ path: '/work/notes.md', line: 3 }] };
    const output = acpToolOutput(mergeAcpToolState(undefined, source), 'session', 'call');
    expect(output).toMatchObject({ rawInput: source.rawInput, rawOutput: source.rawOutput, content: source.content, locations: source.locations });
    expect(acpToolDisplay(mergeAcpToolState(undefined, source))).toEqual({ kind: 'generic', summary: 'Tool' });
  });

  it('neg-truncated-preview-is-not-args', () => {
    const rawInput = { truncated: true, preview: '{"command":"echo ' };
    const state = mergeAcpToolState(undefined, { ...base, kind: 'execute', rawInput });
    expect(acpToolDisplay(state)).toEqual({ kind: 'generic', summary: 'Tool' });
    expect(acpToolOutput(state, 'session', 'call').rawInput).toEqual(rawInput);
  });

  it('neg-progress-then-empty-terminal', () => {
    const progress = mergeAcpToolState(undefined, { type: 'tool.update', toolCallId: 'call-stream-1', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' }, content: [text('running tests')] });
    const state = mergeAcpToolState(progress, { type: 'tool.update', toolCallId: 'call-stream-1', status: 'failed', rawOutput: '', content: [] });
    expect(state.text).toBe('running tests');
    expect(state.syntheticLabel).toBe(true);
    expect(acpToolDisplay(state)).toEqual({ kind: 'command', command: 'npm test' });
    expect(acpToolOutput(state, 'session', 'call')).toMatchObject({ content: progress.content, status: 'failed' });
  });

  it('maps current Kiki FetchURL source.url without guessing non-URL sources', () => {
    const source = { kind: 'url', url: 'https://example.com/current' };
    expect(acpToolDisplay(mergeAcpToolState(undefined, { ...base, kind: 'fetch', rawInput: { action: 'run', source } }))).toEqual({ kind: 'url_fetch', url: source.url });
    expect(acpToolDisplay(mergeAcpToolState(undefined, { ...base, kind: 'fetch', rawInput: { source: { kind: 'file', path: 'a.txt', url: source.url } } }))).toEqual({ kind: 'generic', summary: 'Tool' });
  });

  it('refreshes same-id arguments and diffs without dropping large payloads', () => {
    const content = 'x'.repeat(70_000);
    const initial = mergeAcpToolState(undefined, { ...base, kind: 'edit', rawInput: { path: 'a.ts', content } });
    const updated = mergeAcpToolState(initial, { type: 'tool.update', toolCallId: base.toolCallId, rawInput: { path: 'b.ts', old_string: 'a', new_string: 'b' }, content: [diff('b.ts', 'before', content)] });
    expect(acpToolDisplay(updated)).toEqual({ kind: 'diff', path: 'b.ts', before: 'before', after: content });
    expect(acpToolOutput(initial, 'session', 'call').rawInput).toEqual({ path: 'a.ts', content });
  });

  it.each(['delete', 'move', 'think', 'switch_mode', 'other'])('does not invent edit or agent semantics for %s', (kind) => {
    expect(acpToolDisplay(mergeAcpToolState(undefined, { ...base, kind, rawInput: { path: 'a.ts', content: 'b' } }))).toEqual({ kind: 'generic', summary: 'Tool' });
  });
});

describe('Codex app-server display compatibility', () => {
  it('keeps command/web/subagent/file branches separate from ACP kinds', () => {
    expect(externalToolDisplay({ ...base, kind: 'command', rawInput: { command: 'pwd' } })).toEqual({ kind: 'command', command: 'pwd' });
    expect(externalToolDisplay({ ...base, kind: 'webSearch', rawInput: { query: 'docs' } })).toEqual({ kind: 'search', query: 'docs' });
    expect(externalToolDisplay({ ...base, kind: 'collabAgentToolCall', rawInput: { agent: 'reviewer', prompt: 'inspect' } })).toEqual({ kind: 'agent_call', agent_name: 'reviewer', prompt: 'inspect' });
    expect(externalToolDisplay({ ...base, kind: 'file', rawInput: [{ path: 'a.ts' }] })).toEqual({ kind: 'file_io', operation: 'edit', path: 'a.ts' });
  });
});
