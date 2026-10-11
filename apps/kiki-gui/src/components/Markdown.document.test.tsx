// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { Markdown } from './Markdown';
import { MarkdownFileImage } from './markdown/MarkdownFileImage';

const readHostMediaPreviewBytes = vi.fn(async (_path: string, _options?: unknown) => ({
  bytes: new Uint8Array([137, 80, 78, 71]), mime: 'image/png',
}));
const renderMermaid = vi.hoisted(() => vi.fn(async (_id: string, _code: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
})));
const connectionMock = vi.hoisted(() => ({ activeClient: null as unknown, defaultClient: null as unknown }));
const parseCounts = vi.hoisted(() => ({ documents: 0, blockLexes: 0 }));
vi.mock('streamdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('streamdown')>();
  function observeDocumentParse() {
    return () => { parseCounts.documents += 1; };
  }
  return {
    ...actual,
    defaultRemarkPlugins: { ...actual.defaultRemarkPlugins, observeDocumentParse },
    Streamdown: (props: import('react').ComponentProps<typeof actual.Streamdown>) => (
      <actual.Streamdown {...props} parseMarkdownIntoBlocksFn={props.parseMarkdownIntoBlocksFn ?? ((text) => {
        parseCounts.blockLexes += 1;
        return actual.parseMarkdownIntoBlocks(text);
      })} />
    ),
  };
});
vi.mock('@streamdown/mermaid', () => ({
  mermaid: { getMermaid: () => ({ render: renderMermaid }) },
}));
vi.mock('../host', () => ({ useHost: () => ({ kind: 'browser' }) }));
const fakeClient = { readingOptions: () => ({}), readHostMediaPreviewBytes };
connectionMock.activeClient = fakeClient;
connectionMock.defaultClient = fakeClient;
vi.mock('../state/connection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../state/connection')>(),
  useOptionalConnection: () => ({ client: connectionMock.activeClient, scopeId: 'local' }),
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
  readHostMediaPreviewBytes.mockClear();
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
    expect(readHostMediaPreviewBytes).toHaveBeenCalledWith('/work/docs/assets/diagram.png', expect.anything());
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
    expect(readHostMediaPreviewBytes).toHaveBeenCalledWith('/work/docs/assets/logo.png', expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:versioned-image');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('leaves external image URLs with query strings on the external path', async () => {
  const container = await render('![logo](https://example.test/logo.png?rev=2)', '/work/docs');
  expect(readHostMediaPreviewBytes).not.toHaveBeenCalled();
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/logo.png?rev=2');
});

it('keeps the UNC share prefix when loading a relative image', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:unc-image');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = await render('![diagram](./assets/diagram.png)', '//server/share/docs');
    expect(readHostMediaPreviewBytes).toHaveBeenCalledWith('//server/share/docs/assets/diagram.png', expect.anything());
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
    const image = () => <I18nProvider><MarkdownFileImage src="./assets/diagram.png" documentDirectory="/work/docs" /></I18nProvider>;
    await act(async () => { root.render(image()); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:first-host');

    let finishRead: ((result: { bytes: Uint8Array; mime: string }) => void) | undefined;
    const pending = new Promise<{ bytes: Uint8Array; mime: string }>((resolve) => { finishRead = resolve; });
    connectionMock.activeClient = { readingOptions: () => ({}), readHostMediaPreviewBytes: () => pending };
    await act(async () => { root.render(image()); });
    expect(container.querySelector('img')?.getAttribute('src')).toBeNull();
    await act(async () => { finishRead?.({ bytes: new Uint8Array([1]), mime: 'image/png' }); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:second-host');
  } finally {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('keeps hook order when one image switches between a daemon file and a local path', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:switched-local');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const errors: string[] = [];
  const onError = (event: ErrorEvent) => { errors.push(event.message); };
  window.addEventListener('error', onError);
  try {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const draw = (src: string) => (
      <I18nProvider><MarkdownFileImage src={src} alt="diagram" documentDirectory="/work/docs" /></I18nProvider>
    );
    await act(async () => { root.render(draw('kimi-file://file-daemon')); });
    expect(readHostMediaPreviewBytes).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    await act(async () => { root.render(draw('./assets/diagram.png')); });
    expect(readHostMediaPreviewBytes).toHaveBeenCalledWith('/work/docs/assets/diagram.png', expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:switched-local');
    readHostMediaPreviewBytes.mockClear();
    await act(async () => { root.render(draw('kimi-file://file-daemon')); });
    expect(readHostMediaPreviewBytes).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    expect(errors.join('\n')).not.toMatch(/hooks/i);
  } finally {
    window.removeEventListener('error', onError);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  }
});

it('clears a decode failure when the same image changes path or connection', async () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    .mockReturnValueOnce('blob:broken')
    .mockReturnValueOnce('blob:recovered')
    .mockReturnValueOnce('blob:next-connection');
  const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const container = document.createElement('div');
    document.body.append(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const draw = (src: string) => (
      <I18nProvider><MarkdownFileImage src={src} alt="diagram" documentDirectory="/work/docs" /></I18nProvider>
    );
    await act(async () => { root.render(draw('./assets/broken.png')); });
    const broken = container.querySelector('img');
    expect(broken?.getAttribute('src')).toBe('blob:broken');
    await act(async () => { broken?.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();

    await act(async () => { root.render(draw('./assets/ok.png')); });
    expect(readHostMediaPreviewBytes).toHaveBeenCalledWith('/work/docs/assets/ok.png', expect.anything());
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:recovered');

    const recovered = container.querySelector('img');
    await act(async () => { recovered?.dispatchEvent(new Event('error')); });
    expect(container.querySelector('img')).toBeNull();
    connectionMock.activeClient = {
      readingOptions: () => ({}),
      readHostMediaPreviewBytes: async () => ({ bytes: new Uint8Array([2]), mime: 'image/png' }),
    };
    await act(async () => { root.render(draw('./assets/ok.png')); });
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:next-connection');
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


it('shows timeline data and URL images without weakening link or HTML sanitization', async () => {
  const urls = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1cAAAAASUVORK5CYII=',
    'data:image/jpeg;base64,/9j/2Q==',
    'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E',
    'https://example.test/image.png',
    'blob:example-image',
  ];
  const container = await render(urls.map((url) => `![diagram](${url})`).join('\n\n') + '\n\n[unsafe](javascript:alert(1))\n\n<img src="javascript:alert(1)" onerror="alert(1)"><script>alert(1)</script>');
  expect([...container.querySelectorAll('img')].map((image) => image.getAttribute('src')).filter(Boolean)).toEqual(urls);
  expect(container.textContent).not.toContain('diagram [blocked]');
  expect(container.textContent).toContain('unsafe [blocked]');
  expect(container.textContent).toContain('[Image blocked:');
  expect(container.querySelector('script, [onerror], a[href^="javascript:"]')).toBeNull();
  expect(readHostMediaPreviewBytes).not.toHaveBeenCalled();
});


it('keeps a local Markdown image unloaded when its connection is unavailable', async () => {
  connectionMock.activeClient = undefined;
  const container = await render('![diagram](./assets/diagram.png)', '/work/docs');
  expect(container.querySelector('img')?.getAttribute('src')).toBeNull();
  expect(readHostMediaPreviewBytes).not.toHaveBeenCalled();
});


it('parses static documents once without unused streaming lexing or navigation reparses', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const text = '# Beginning\n\n[local](./other.md)\n\n## End\n\nComplete final paragraph.';
  const draw = (navigation: { path: string } | undefined, content = text, directory = '/work') => (
    <MemoryRouter><I18nProvider>
      <Markdown mode="static" text={content} documentDirectory={directory} documentPath={`${directory}/readme.md`} headingNavigation={navigation} />
    </I18nProvider></MemoryRouter>
  );
  parseCounts.documents = 0;
  parseCounts.blockLexes = 0;
  await act(async () => { root.render(draw({ path: '/work/readme.md' })); });
  expect(parseCounts.documents).toBe(1);
  expect(parseCounts.blockLexes).toBe(0);
  const originalHeading = container.querySelector('h2');
  expect(originalHeading?.textContent).toBe('End');

  await act(async () => { root.render(draw(undefined)); });
  expect(parseCounts.documents).toBe(1);
  expect(container.querySelector('h2')).toBe(originalHeading);
  expect(container.textContent).toContain('Complete final paragraph.');

  await act(async () => { root.render(draw(undefined, `${text}\n\nChanged final content.`)); });
  expect(parseCounts.documents).toBe(2);
  expect(container.textContent).toContain('Changed final content.');

  await act(async () => { root.render(draw(undefined, `${text}\n\nChanged final content.`, '/other')); });
  expect(parseCounts.documents).toBe(3);
  expect(container.querySelector('h2')).not.toBe(originalHeading);
  expect(container.textContent).toContain('Changed final content.');
});
