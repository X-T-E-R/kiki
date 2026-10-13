// @vitest-environment jsdom
import { act } from 'react';

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { projectExternalToolDisplay } from '@kiki/protocol';
import type { ToolBlock } from '@kiki/session-core/session/transcript';
import { groupBlocks } from '@kiki/session-core/session/grouping';

import { I18nProvider } from '../i18n';
import { ToolCard, toolIcon } from './ToolCard';

function tool(overrides: Partial<ToolBlock> & Pick<ToolBlock, 'toolCallId' | 'name'>): ToolBlock {
  return {
    kind: 'tool',
    id: overrides.toolCallId,
    argsText: '',
    args: {},
    display: undefined,
    description: undefined,
    status: 'done',
    output: undefined,
    isError: undefined,
    durationMs: undefined,
    progressText: undefined,
    ...overrides,
  };
}

async function renderCard(block: ToolBlock): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><ToolCard block={block} /></I18nProvider>);
  });
  return { root, container };
}

describe('external tool rows use the native display', () => {
  it.each(['en', 'zh'])('shows a command and a read once, in %s', async (locale) => {
    localStorage.setItem('kiki.locale', locale);
    const command = tool({
      toolCallId: 'external:agy:run', name: 'run_command', status: 'error', isError: true,
      args: { CommandLine: 'rg -n tool src', Cwd: '/workspace/example' },
      display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
      output: { kind: 'external_tool_output', protocol: 'acp-v1', text: 'exit 1', rawInput: { CommandLine: 'rg -n tool src' } },
    });
    expect(toolIcon(command)).toBe('terminal');
    const shown = await renderCard(command);
    const row = shown.container.querySelector('[data-tool-name="run_command"]');
    expect(row?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('terminal');
    expect(row?.textContent).toContain('Run');
    expect(row?.textContent).toContain('rg -n tool src');
    expect(row?.textContent).toContain('/workspace/example');
    expect(row?.textContent?.match(/run_command/g) ?? []).toHaveLength(0);
    expect(shown.container.querySelector('[data-outcome="failed"]')).not.toBeNull();
    await act(async () => { shown.container.querySelector<HTMLButtonElement>('[data-activity-toggle]')?.click(); });
    expect(shown.container.textContent).toContain('rg -n tool src');
    expect(shown.container.textContent).toContain('exit 1');
    await act(async () => shown.root.unmount());
    shown.container.remove();

    const read = tool({
      toolCallId: 'external:agy:view', name: 'view_file',
      display: { kind: 'file_io', operation: 'read', path: '/workspace/example/file.ts' },
    });
    expect(toolIcon(read)).toBe('read');
    const file = await renderCard(read);
    expect(file.container.querySelector('[data-tool-name="view_file"]')?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('read');
    expect(file.container.textContent).toContain('Read');
    expect(file.container.textContent).toContain('/workspace/example/file.ts');
    expect(file.container.textContent).not.toContain('view_file');
    await act(async () => file.root.unmount());
    file.container.remove();
    localStorage.removeItem('kiki.locale');
  });

  it('keeps a declined generic label and does not invent a hunk from args', async () => {
    const block = tool({
      toolCallId: 'external:session:edit', name: 'Write',
      display: { kind: 'generic', summary: 'Unknown edit', detail: { kind: 'other' } },
      args: { path: 'a.ts', content: 'do not invent a hunk' },
      output: {},
    });
    expect(toolIcon(block)).toBe('tool');
    const shown = await renderCard(block);
    expect(shown.container.querySelector('[data-tool-semantic]')).toBeNull();
    expect(shown.container.textContent).toContain('Write');
    expect(shown.container.textContent).toContain('Unknown edit');
    await act(async () => { shown.container.querySelector<HTMLButtonElement>('[data-activity-toggle]')?.click(); });
    expect(shown.container.querySelector('[data-diff]')).toBeNull();
    expect(shown.container.textContent).toContain('do not invent a hunk');
    await act(async () => shown.root.unmount());
    shown.container.remove();
  });

  it('shows every diff path and folds consecutive external reads', async () => {
    const block = tool({
      toolCallId: 'external:agy:diffs', name: 'replace_file_content',
      display: {
        kind: 'generic',
        summary: '/workspace/example/a.ts, /workspace/example/b.ts',
        detail: {
          diffs: [
            { path: '/workspace/example/a.ts', before: 'a', after: 'b' },
            { path: '/workspace/example/b.ts', before: 'c', after: 'd' },
          ],
        },
      },
    });
    expect(toolIcon(block)).toBe('edit');
    const shown = await renderCard(block);
    expect(shown.container.textContent).toContain('Edit');
    expect(shown.container.textContent).toContain('/workspace/example/a.ts');
    expect(shown.container.textContent).toContain('/workspace/example/b.ts');
    await act(async () => { shown.container.querySelector<HTMLButtonElement>('[data-activity-toggle]')?.click(); });
    expect(shown.container.textContent).toContain('/workspace/example/a.ts');
    expect(shown.container.textContent).toContain('/workspace/example/b.ts');
    await act(async () => shown.root.unmount());
    shown.container.remove();

    const reads = ['/workspace/example/a.ts', '/workspace/example/b.ts', '/workspace/example/c.ts'].map((path, index) => tool({
      toolCallId: `external:agy:view-${index}`, name: 'view_file',
      display: { kind: 'file_io', operation: 'read', path },
    }));
    const command = tool({
      toolCallId: 'external:agy:run', name: 'run_command',
      display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
    });
    const nodes = groupBlocks([...reads, command]);
    expect(nodes[0]).toMatchObject({ kind: 'tool-group', count: 3 });
    expect(nodes[1]).toMatchObject({ kind: 'tool', name: 'run_command' });
  });

  it('keeps a stopped command readable', async () => {
    const block = tool({
      toolCallId: 'external:agy:stop', name: 'run_command', status: 'stopped',
      display: { kind: 'command', command: 'rg -n tool src', cwd: '/workspace/example' },
      output: 'partial',
    });
    const shown = await renderCard(block);
    expect(shown.container.querySelector('[data-outcome="stopped"]')).not.toBeNull();
    expect(shown.container.textContent).toContain('rg -n tool src');
    expect(shown.container.querySelector('[data-tool-name="run_command"]')).not.toBeNull();
    await act(async () => shown.root.unmount());
    shown.container.remove();
  });

  it('renders a Codex multi-file change as an edit and an ACP multi-file read as a read', async () => {
    const codex = projectExternalToolDisplay({
      title: 'File change', kind: 'file', summary: 'File change',
      rawInput: [{ path: '/workspace/example/a.ts' }, { path: '/workspace/example/b.ts' }],
    });
    expect(codex).toMatchObject({ kind: 'generic', detail: { operation: 'edit' } });
    const edited = tool({ toolCallId: 'external:codex:files', name: 'File change', display: codex });
    expect(toolIcon(edited)).toBe('edit');
    const editCard = await renderCard(edited);
    const editRow = editCard.container.querySelector('[data-tool-name="File change"]');
    expect(editRow?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('edit');
    expect(editRow?.textContent).toContain('Edit');
    expect(editRow?.textContent).toContain('/workspace/example/a.ts');
    expect(editRow?.textContent).toContain('/workspace/example/b.ts');
    expect(editRow?.textContent).not.toContain('Read');
    await act(async () => editCard.root.unmount());
    editCard.container.remove();

    const reads = projectExternalToolDisplay({
      name: 'view_file', title: 'view_file', kind: 'read', summary: 'view_file',
      locations: [{ path: '/workspace/example/a.ts' }, { path: '/workspace/example/b.ts' }],
    });
    expect(reads).toMatchObject({ kind: 'generic', detail: { operation: 'read' } });
    const readBlock = tool({ toolCallId: 'external:agy:views', name: 'view_file', display: reads });
    expect(toolIcon(readBlock)).toBe('read');
    const readCard = await renderCard(readBlock);
    const readRow = readCard.container.querySelector('[data-tool-name="view_file"]');
    expect(readRow?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('read');
    expect(readRow?.textContent).toContain('Read');
    expect(readRow?.textContent).not.toContain('Edit');
    await act(async () => readCard.root.unmount());
    readCard.container.remove();

    const unlabeled = tool({
      toolCallId: 'external:codex:bare', name: 'File change',
      display: {
        kind: 'generic',
        summary: '/workspace/example/a.ts, /workspace/example/b.ts',
        detail: { paths: ['/workspace/example/a.ts', '/workspace/example/b.ts'] },
      },
    });
    expect(toolIcon(unlabeled)).toBe('tool');
    const bare = await renderCard(unlabeled);
    expect(bare.container.querySelector('[data-tool-name="File change"]')?.textContent).toContain('File change');
    expect(bare.container.textContent).not.toContain('Read');
    await act(async () => bare.root.unmount());
    bare.container.remove();
  });
});
