// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { Markdown } from './Markdown';
import { MarkdownFileImage } from './markdown/MarkdownFileImage';

const readHostFileBytes = vi.fn(async (_path: string) => ({
  bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png',
}));
const renderMermaid = vi.hoisted(() => vi.fn(async (_id: string, _code: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
})));
const connectionMock = vi.hoisted(() => ({ activeClient: null as unknown, defaultClient: null as unknown }));
vi.mock('@streamdown/mermaid', () => ({
  mermaid: { getMermaid: () => ({ render: renderMermaid }) },
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
const fakeClient = { readHostFileBytes };
connectionMock.activeClient = fakeClient;
connectionMock.defaultClient = fakeClient;
vi.mock('../state/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/connection')>(),
  useOptionalConnection: () => ({ client: connectionMock.activeClient }),
}));

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

async function render(text: string, documentDirectory?: string): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<MemoryRouter><I18nProvider>
      <Markdown mode="static" text={text} documentDirectory={documentDirectory} />
    </I18nProvider></MemoryRouter>);
  });
  return container;
}

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount(); });
  for (const container of containers.splice(0)) container.remove();
  connectionMock.activeClient = connectionMock.defaultClient;
  readHostFileBytes.mockClear();
  renderMermaid.mockClear();
});

it('renders a complete GFM document without streaming repair of an unfinished fence', async () => {
  const container = await render('# Notes\n\n- [x] done\n\n| a | b |\n| - | - |\n| one | two |\n\n```ts\nconst x = 1');
  expect(container.querySelector('h1')?.textContent).toBe('Notes');
  expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
  expect(container.querySelector('table')?.textContent).toContain('one');
  expect(container.textContent).toContain('const x = 1');
});

it('loads math from the maintained Streamdown plugin', async () => {
  const container = await render('$$\nx^2 + y^2\n$$');
  await act(async () => { await import('@streamdown/math'); });
  expect(container.querySelector('.katex')).not.toBeNull();
});

it('resolves relative Markdown images against the document, not the workspace root', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:markdown-image');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = await render('![diagram](./assets/diagram.png)', '/work/docs');
    expect(readHostFileBytes).toHaveBeenCalledWith('/work/docs/assets/diagram.png');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:markdown-image');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('loads relative images with URL query and fragment suffixes from the document directory', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:versioned-image');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = await render('![logo](assets/logo.png?rev=2#caption)', '/work/docs');
    expect(readHostFileBytes).toHaveBeenCalledWith('/work/docs/assets/logo.png');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:versioned-image');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('leaves external image URLs with query strings on the external path', async () => {
  const container = await render('![logo](https://example.test/logo.png?rev=2)', '/work/docs');
  expect(readHostFileBytes).not.toHaveBeenCalled();
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/logo.png?rev=2');
});

it('keeps the UNC share prefix when loading a relative image', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unc-image');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = await render('![diagram](./assets/diagram.png)', '//server/share/docs');
    expect(readHostFileBytes).toHaveBeenCalledWith('//server/share/docs/assets/diagram.png');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:unc-image');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('does not retain an image from the previous connection while the next one loads', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    .mockReturnValueOnce('blob:first-host').mockReturnValueOnce('blob:second-host');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const image = () => <MarkdownFileImage src="./assets/diagram.png" documentDirectory="/work/docs" />;
    await act(async () => { root.render(image()); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first-host');

    let finishRead: ((result: { bytes: Uint8Array; mime: string }) => void) | undefined;
    const pending = new Promise<{ bytes: Uint8Array; mime: string }>((resolve) => { finishRead = resolve; });
    connectionMock.activeClient = { readHostFileBytes: () => pending };
    await act(async () => { root.render(image()); });
    expect(container.querySelector('img')?.getAttribute('src')).toBeNull();
    await act(async () => { finishRead?.({ bytes: new Uint8Array([1]), mime: 'image/png' }); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:second-host');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('renders Mermaid as an inert image and leaves invalid diagrams as code', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:markdown-diagram');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = await render('```mermaid\ngraph LR\n  Start --> Done\n```');
    await act(async () => { await import('@streamdown/mermaid'); });
    expect(renderMermaid).toHaveBeenCalledWith(expect.stringMatching(/^kiki-mermaid-/), 'graph LR\n  Start --> Done');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:markdown-diagram');
    expect(container.querySelector('svg')).toBeNull();
    expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({ type: 'image/svg+xml' });

    renderMermaid.mockRejectedValueOnce(new Error('Invalid Mermaid diagram'));
    const invalid = await render('```mermaid\ninvalid\n```');
    expect(invalid.querySelector('img')).toBeNull();
    expect(invalid.textContent).toContain('invalid');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});
