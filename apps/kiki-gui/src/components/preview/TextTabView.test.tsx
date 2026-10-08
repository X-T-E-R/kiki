// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { TextTabView, isHtmlPreviewPath, sandboxedHtmlDocument } from './TextTabView';

const markdownRenderCount = vi.hoisted(() => ({ value: 0 }));
const hostMock = vi.hoisted(() => ({
  kind: 'browser' as const,
  writeFileText: undefined,
}));
const connectionMock = vi.hoisted(() => ({
  client: null as unknown,
  scopeId: 'local',
}));

vi.mock('../../host', () => ({
  useHost: () => hostMock,
}));

vi.mock('../../state/connection', () => ({
  useOptionalConnection: () => connectionMock,
}));

vi.mock('../../lib/toasts', () => ({
  runToastAction: (_label: string, action: () => Promise<void>) => { void action(); },
}));

vi.mock('../icons', () => ({
  Icon: () => <span aria-hidden />,
}));

vi.mock('../CodeEditor', () => ({
  CodeEditor: ({
    value,
    onChange,
  }: {
    readonly value: string;
    readonly onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="source-editor"
      value={value}
      onChange={(event) => { onChange(event.currentTarget.value); }}
    />
  ),
}));

vi.mock('../Markdown', () => ({
  Markdown: ({ text }: { readonly text: string }) => {
    markdownRenderCount.value += 1;
    return <div data-testid="rendered-markdown">{text}</div>;
  },
}));

let root: Root;
let container: HTMLDivElement;

function makeClient(content: string, mime: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    readingOptions: () => ({ timeoutMs: 0 }),
    previewHostFile: vi.fn(async () => ({ text: content, truncated: false })),
    readHostFileBytes: vi.fn(async () => ({ bytes, mime })),
  };
}

async function renderTab(client: unknown, path: string, markdown: boolean): Promise<void> {
  connectionMock.client = client;
  await act(async () => {
    root.render(
      <I18nProvider>
        <TextTabView path={path} markdown={markdown} reportDirty={() => {}} onReadingReady={() => {}} />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickMode(mode: 'rendered' | 'source'): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-preview-mode="${mode}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  markdownRenderCount.value = 0;
  connectionMock.client = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  connectionMock.client = null;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('sandboxed HTML document', () => {
  it('recognizes HTML paths and keeps the source inside a restrictive policy', () => {
    expect(isHtmlPreviewPath('/work/page.html')).toBe(true);
    expect(isHtmlPreviewPath('C:\\work\\page.htm')).toBe(true);
    expect(isHtmlPreviewPath('/work/page.md')).toBe(false);

    const source = '<!-- <head>fake</head> --><!doctype html><html><head><base href="https://example.test/"><meta http-equiv="refresh" content="0;url=https://example.test/"><title>Fixture</title></head><body><script>top.postMessage(1, "*")</script><a href="https://example.test/remote">Remote</a><img src="https://example.test/remote.png"><img src="data:image/png;base64,AA=="></body></html>';
    const documentSource = sandboxedHtmlDocument(source);
    expect(documentSource.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(documentSource).toContain('<title>Fixture</title>');
    expect(documentSource).not.toContain('<base');
    expect(documentSource).not.toContain('http-equiv="refresh"');
    expect(documentSource).not.toContain('href="https://example.test/remote"');
    expect(documentSource).toContain("default-src 'none'");
    expect(documentSource).toContain("script-src 'none'");
    expect(documentSource).toContain("style-src 'unsafe-inline'");
    expect(documentSource).toContain('img-src data:');
    expect(documentSource).toContain("form-action 'none'");
    expect(documentSource).toContain("frame-ancestors 'none'");
    expect(documentSource).toContain('referrer');
  });
});

describe('TextTabView mode residency', () => {
  it('renders HTML bytes in a no-permission iframe and does not use parent HTML', async () => {
    const source = '<!doctype html><html><head><style>body { color: red }</style></head><body><script>window.ran = true</script><img src="https://example.test/remote.png"><p>safe</p></body></html>';
    const client = makeClient(source, 'text/html');
    await renderTab(client, '/work/page.html', false);

    const iframe = container.querySelector<HTMLIFrameElement>('[data-preview-html]');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe('');
    expect(iframe!.getAttribute('allow')).toBeNull();
    expect(iframe!.getAttribute('referrerpolicy')).toBe('no-referrer');
    const documentSource = iframe!.getAttribute('srcdoc') ?? '';
    expect(documentSource).toContain("default-src 'none'");
    expect(documentSource).toContain("script-src 'none'");
    expect(documentSource).toContain('img-src data:');
    expect(container.querySelector('script')).toBeNull();
    expect(client.readHostFileBytes).toHaveBeenCalledTimes(1);
    expect(client.previewHostFile).not.toHaveBeenCalled();
    const initialFrame = iframe;
    await clickMode('source');
    await clickMode('rendered');
    expect(container.querySelector('[data-preview-html]')).toBe(initialFrame);
    expect(client.readHostFileBytes).toHaveBeenCalledTimes(1);
  });

  it('keeps the rendered Markdown tree resident and frozen during source edits', async () => {
    const source = '# Beginning\n\nA paragraph.';
    const client = makeClient(source, 'text/markdown');
    await renderTab(client, '/work/readme.md', true);
    expect(markdownRenderCount.value).toBe(1);

    await clickMode('source');
    expect(markdownRenderCount.value).toBe(1);
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="source-editor"]');
    expect(editor).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(editor!, `${source}\n\nEdited`);
      editor!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(markdownRenderCount.value).toBe(1);

    await clickMode('rendered');
    expect(markdownRenderCount.value).toBe(2);
    expect(container.querySelector('[data-testid="rendered-markdown"]')?.textContent).toContain('Edited');
  });
});
