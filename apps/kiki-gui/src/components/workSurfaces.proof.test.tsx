// @vitest-environment jsdom
/**
 * Visual proof of the Work surfaces, captured to `.tmp/work-shots`.
 *
 *   npx vitest run src/workSurfaces.proof.tsx
 *
 * These mount the real components and write PNGs, so the image is evidence of
 * what the app paints rather than a description of it. Only the network is
 * replaced — the work-presets and document-preview answers are fixtures, and
 * the preview assets are inline SVG standing in for a rendered page image.
 * The preview-tab capture exercises the session-media branch specifically: an
 * attachment PDF has to reach the page canvas, not the workspace reader.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationShell } from './ConversationShell';
import { WorkModeMenu } from './WorkModeMenu';
import { WorkPage } from './WorkPage';
import { WorkSetupSheet } from './WorkSetupSheet';
import { DocumentTabView } from './preview/DocumentTabView';

const PROOF_CLIENT = {
  documentPreview: async () => RESPONSES[fixture.response as keyof typeof RESPONSES],
  readDocumentPreviewAsset: async (url: string) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf', url }),
  installPluginPrerequisite: async (pluginId: string, prerequisiteId: string) => {
    fixture.enableCalls.push({ id: pluginId, prerequisites: prerequisiteId });
    return { ok: true as const };
  },
} as never;

const OUT = process.env['KIKI_PROOF_OUTPUT_DIR']
  ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp', 'work-shots');

const writing = { id: 'kiki-writing', name: 'Writing', purpose: 'Turn notes and source material into an editable draft.', required: true, installed: true, enabled: true, available: true };
const extract = { id: 'kiki-extract', name: 'Extract', purpose: 'Extract readable material from documents and web pages.', required: true, installed: true, enabled: true, available: true };
const office = { id: 'kiki-office', name: 'Office', purpose: 'Create, inspect, edit and preview Word, Excel and PowerPoint files.', required: true, installed: false, enabled: false, available: true, prerequisite: 'officecli' };
const tables = { id: 'kiki-work', name: 'Table checks', purpose: 'Compare CSV tables by key and report missing, changed and duplicate rows.', required: false, installed: false, enabled: false, available: true };

const workItem = { id: 'work', name: 'Work', description: 'Read office material, write and extract documents, and check tables.', enabled: true, removed: false, preferences: {}, plugins: [writing, extract, office, tables] };
const kikiItem = { id: 'kiki', name: 'Kiki', description: 'General-purpose conversations and projects.', enabled: true, removed: false, preferences: {}, plugins: [] };
const workOffItem = { ...workItem, enabled: false, plugins: [writing, extract, { ...office, installed: true, enabled: false }] };

const pageAsset = (seed: string, label: string): { asset_id: string; mime: string; url: string; width: number; height: number } => ({
  asset_id: seed.repeat(24),
  mime: 'image/png',
  url: `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1180"><rect width="900" height="1180" fill="#fff"/>`
    + `<rect x="0" y="0" width="900" height="8" fill="#c8401a"/>`
    + `<text x="72" y="120" font-family="Georgia,serif" font-size="38" fill="#1b1a17">${label}</text>`
    + `<text x="72" y="168" font-family="Helvetica,sans-serif" font-size="17" fill="#665e54">Rendered from the server — layout preserved</text>`
    + `${Array.from({ length: 11 }, (_, i) => `<rect x="72" y="${230 + i * 46}" width="${520 - (i % 4) * 70}" height="13" rx="3" fill="#e4ddd0"/>`).join('')}`
    + `<rect x="72" y="760" width="756" height="300" rx="8" fill="#f2efe8" stroke="#e4ddd0"/>`
    + `${Array.from({ length: 5 }, (_, i) => `<rect x="96" y="${800 + i * 52}" width="${420 - (i % 3) * 90}" height="11" rx="3" fill="#cdc3b1"/>`).join('')}`
    + `</svg>`,
  )}`,
  width: 900,
  height: 1180,
});

const RESPONSES = {
  office: {
    kind: 'ready', format: 'pptx', fidelity: 'rendered', renderer: 'officecli',
    source: { kind: 'workspace', name: 'renewal-deck.pptx', media_type: 'application/vnd.ms-powerpoint', size: 99812 },
    navigation: { kind: 'page', page: 2, page_count: 14 },
    assets: [pageAsset('a', 'Renewal deck — slide 2 of 14')], read_only: true,
  },
  sheet: {
    kind: 'ready', format: 'xlsx', fidelity: 'rendered', renderer: 'officecli',
    source: { kind: 'workspace', name: 'headcount.xlsx', media_type: 'application/vnd.ms-excel', size: 4389 },
    navigation: { kind: 'sheet', sheet: 'Q3', sheet_index: 2, sheet_count: 5 },
    assets: [pageAsset('b', 'headcount.xlsx — Q3')], read_only: true,
  },
  attachment: {
    kind: 'ready', format: 'pdf', fidelity: 'rendered', renderer: 'browser-pdf',
    source: { kind: 'session-media', name: 'supplier-terms.pdf', media_type: 'application/pdf', size: 312000 },
    navigation: { kind: 'page', page: 1, page_count: 9 },
    assets: [{ asset_id: 'c'.repeat(24), mime: 'application/pdf', url: '/api/sessions/s1/document-preview/assets/cccccccccccccccccccccccc', width: 1240, height: 1754 }],
    read_only: true,
  },
  pdfNoCount: {
    kind: 'ready', format: 'pdf', fidelity: 'rendered', renderer: 'browser-pdf',
    source: { kind: 'workspace', name: 'manual.pdf', media_type: 'application/pdf', size: 88000 },
    navigation: { kind: 'page', page: 1 },
    assets: [{ asset_id: 'd'.repeat(24), mime: 'application/pdf', url: '/api/sessions/s1/document-preview/assets/dddddddddddddddddddddddddddd', width: 1240, height: 1754 }],
    read_only: true,
  },
  csv: {
    kind: 'text', format: 'csv', fidelity: 'source',
    source: { kind: 'workspace', name: 'vendors.csv', media_type: 'text/csv', size: 40960 },
    encoding: 'utf-8',
    content: 'vendor,region,spend,renews\nNorthwind,EMEA,18400,2026-11-02\nCalder,APAC,9120,2027-01-18\nBrightmoor,AMER,24350,2026-09-30\n',
    offset: 0, truncated: true, next_offset: 118, total_bytes: 40960, read_only: true,
  },
  missing: {
    kind: 'missing_dependency', dependency: 'officecli',
    source: { kind: 'workspace', name: 'contract.docx', media_type: 'application/msword', size: 22140 },
    message: 'OfficeCLI is not installed, so Word, Excel and PowerPoint cannot be rendered here.',
    recovery: { kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true },
    read_only: true,
  },
} as const;

type ResponseKey = keyof typeof RESPONSES;
let response: ResponseKey = 'office';
let catalog: { items: unknown[] } = { items: [kikiItem, workItem] };
const fixture = vi.hoisted(() => ({
  response: 'office' as string,
  items: [] as unknown[],
  enableCalls: [] as unknown[],
  listWorkPresets: async (): Promise<{ home_id: string; items: unknown[] }> => ({ home_id: 'main', items: fixture.items }),
  enableWorkPreset: async (id: string, prerequisites: boolean) => {
    fixture.enableCalls.push({ id, prerequisites });
    return { preset: {}, completed: ['kiki-office'], failures: [] };
  },
}));

vi.mock('../state/connection', () => {
  const client = {
    listWorkPresets: fixture.listWorkPresets,
    enableWorkPreset: fixture.enableWorkPreset,
    documentPreview: async () => RESPONSES[fixture.response as keyof typeof RESPONSES],
    readDocumentPreviewAsset: async (url: string) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf', url }),
    installPluginPrerequisite: async (pluginId: string, prerequisiteId: string) => {
      fixture.enableCalls.push({ id: pluginId, prerequisites: prerequisiteId });
      return { ok: true as const };
    },
  };
  return {
    useConnection: () => ({ client, scopeId: 'local', meta: { experimental_flags: { work_presets: true } } }),
    useOptionalConnection: () => ({ client, scopeId: 'local' }),
  };
});
vi.mock('../i18n', () => ({ I18nProvider: ({ children }: { children: ReactNode }) => children, useI18n: () => ({ t: (key: string, params?: Record<string, string>) => (COPY[key] ?? key).replace(/\{(\w+)\}/g, (m, n: string) => params?.[n] ?? m), locale: 'en', time: {} }) }));
vi.mock('../NewSessionDraft', () => ({
  useNewSessionDraft: () => DRAFT,
  isAbsoluteCwdPath: (value: string) => /^\/[A-Za-z]:/.test(value),
}));
vi.mock('./Composer', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./Composer');
  return { ...actual, Composer: () => <div data-proof-composer /> };
});
vi.mock('./ContextMeter', () => ({ ContextBreakdownProvider: ({ children }: { children: ReactNode }) => <>{children}</> }) as Record<string, unknown>);
vi.mock('./host', () => ({ useHost: () => ({ kind: 'browser' }) }));
vi.mock('./preview/PdfPageView', () => ({
  PdfPageView: ({ assetUrl, page, name, onPageCount }: { assetUrl: string; page: number; name: string; onPageCount?: (n: number) => void }) => (
    <div data-proof-pdf-canvas data-page={page} data-name={name} data-asset-url={assetUrl}>
      <button type="button" data-proof-pdf-count onClick={() => { onPageCount?.(7); }}>7</button>
    </div>
  ),
}));
vi.mock('./preview/PreviewAssetImage', () => ({
  PreviewAssetImage: ({ url, alt }: { url: string; alt: string }) => (
    <div data-proof-asset-read data-asset-url={url} aria-label={alt} />
  ),
}));

const COPY: Record<string, string> = {
  'workHome.eyebrow': 'Work mode',
  'workHome.headline': 'Office material in, checked output out.',
  'workHome.subhead': 'Start from the file you already have. Every task below opens a new session in this window with the tools Work provides.',
  'workHome.startHeading': 'Start a task',
  'workHome.task.review': 'Review a document',
  'workHome.task.reviewBody': 'Read a .docx, .pdf or .pptx and get a written read on it.',
  'workHome.task.draft': 'Draft from source material',
  'workHome.task.draftBody': 'Turn notes and extracts into an editable draft.',
  'workHome.task.extract': 'Pull text out of a file',
  'workHome.task.extractBody': 'Extract readable material into a note you can search later.',
  'workHome.task.tables': 'Compare two tables',
  'workHome.task.tablesBody': 'Match CSV or .xlsx by key and report what changed.',
  'new.title': 'New session',
  'workMode.aria': 'Window mode',
  'workMode.menu': 'Change window mode',
  'workMode.appliesToWindow': 'Applies to this window. Other windows on this space keep their own mode.',
  'workMode.sameSpaceSecondWindow': 'Switching keeps every session, memory and background task. Use a second window to work in two modes at once.',
  'workMode.enabled': 'Ready',
  'workMode.needsSetup': 'Not set up here',
  'workMode.open': 'Open in a new window',
  'workMode.loadFailed': 'Could not read the modes in this space.',
  'workMode.retry': 'Try again',
  'workSetup.title': 'Work in this space',
  'workSetup.eyebrow': 'Set up {name}',
  'workSetup.body': '{description} This adds the parts you are missing and leaves what you already have alone. Your model connections and existing files are reused as they are.',
  'workSetup.haveHeading': 'What this space already has',
  'workSetup.addHeading': 'What this adds',
  'workSetup.itemInstalledOn': 'Installed and on',
  'workSetup.itemMissing': 'Not installed yet',
  'workSetup.itemOptional': 'Optional',
  'workSetup.prereqTitle': '{name} — {size}',
  'workSetup.prereqBody': '{body}',
  'workSetup.prereqConsent': 'Install it now, in the same step',
  'workSetup.prereqSkipNote': '{name} works without it. Previews of these formats stay unavailable until it is installed.',
  'workSetup.confirm': 'Set up {name}',
  'workSetup.decline': 'Not now',
  'workSetup.working': 'Setting up…',
  'workSetup.doneTitle': '{name} is ready',
  'workSetup.doneBody': 'You can start a task below.',
  'workSetup.doneAction': 'Start working',
  'workSetup.partialBody': '{done} of {total} parts are ready. What worked is kept.',
  'workSetup.partialAction': 'Retry the rest',
  'workSetup.close': 'Close',
  'workSetup.failedItem': '{name} could not be installed. {reason}',
  'workSetup.reuseNote': 'Existing sessions keep the tools they were created with.',
  'preview.rendering': 'Rendering this page…',
  'preview.tryAgain': 'Try again',
  'preview.pageOf': 'Page {page} of {count}',
  'preview.previousPage': 'Previous page',
  'preview.nextPage': 'Next page',
  'preview.sheet': 'Sheet',
  'preview.fidelitySource': 'File text',
  'preview.pageAlt': '{page} of {name}',
  'preview.sourceTextNotice': '{name} is shown as its own text, not as a laid-out page.',
  'preview.loadMore': 'Show more',
  'preview.rendererShared': 'One setup makes this work for every file of this kind.',
  'preview.installRenderer': 'Set up the renderer',
  'preview.pdfFailed': 'This page could not be drawn.',
  'preview.failed': 'Could not load this file',
  'common.cancel': 'Cancel',
};


const DRAFT = {
  persona: undefined, personaPending: false, selectPersona: () => {}, dailyPersonaId: undefined, dailyPersonaName: undefined,
  draft: '', attachments: [], busy: false, error: undefined, workspaceId: 'ws-1', cwd: '', permissionMode: 'manual', planMode: false,
  goalObjective: '', modelOverride: undefined, agentProfile: undefined, execution: undefined, setExecution: () => {},
  workspaces: [], workspacesLoading: false, effectiveWorkspace: { id: 'ws-1', name: 'Documents' }, autoWorkspace: false,
  worktreeAvailability: undefined, worktreeRequested: false, setWorktreeRequested: () => {}, ephemeral: false, setEphemeral: () => {},
  agentProfileCatalogMode: 'global', agentProfileCatalogPending: false, needsProviderSetup: false, sshLabel: null,
  canBrowseForWorkspace: false, browseForWorkspace: () => {}, serverDefaultModel: undefined, inheritedDefault: 'axon/gpt-6.1-sol',
  modelSource: 'server', supportedEfforts: [], effectiveEffort: undefined, updateDraft: () => {}, setAttachments: () => {},
  selectWorkspace: () => {}, setCwd: () => {}, setPermissionMode: () => {}, setPlanMode: () => {}, setGoalObjective: () => {},
  setModelOverride: () => {}, setAgentProfile: () => {}, setEffortOverride: () => {}, send: () => {}, activateSkill: () => {},
};

let root: Root;
let container: HTMLDivElement;

/**
 * Renders the mounted markup in a real browser with Kiki's own token CSS, so
 * the PNG is evidence of what the app paints. Only enabled with `--capture`;
 * the assertions above are the default and do not need a browser.
 */
async function shoot(name: string, width: number, height: number): Promise<void> {
  if (process.env['KIKI_CAPTURE_WORK'] !== '1') return;
  const { chromium } = await import('playwright');
  const { readFile, mkdir } = await import('node:fs/promises');
  const OUT = process.env['KIKI_PROOF_OUTPUT_DIR'] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp', 'work-shots');
  // The compiled stylesheet: index.css is Tailwind source, so injecting it
  // raw would render every utility as a no-op and prove nothing.
  const css = await readFile(join(OUT, 'real.css'), 'utf8');
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.setContent(
    `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><style>${css}</style></head>`
    // The real shell classes, so column centring and the header strip are the
    // ones the app actually applies.
    + `<body class="bg-canvas text-ink"><div class="app-sheet" style="height:100vh"><div class="conversation-shell" data-phase="hero">`
    + `<div class="conversation-row"><div class="conversation-center">${document.body.innerHTML}</div></div>`
    + `</div></div></body></html>`,
  );
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await browser.close();
}

async function mount(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** WorkPage lives under the conversation shell, which owns the composer slot. */
async function mountInShell(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/work']}>
          <Routes>
            <Route element={<ConversationShell />}>
              <Route path="/work" element={node} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => { act(() => { root.unmount(); }); });
beforeEach(async () => {
  fixture.response = 'office';
  fixture.items = [kikiItem, workItem];
  fixture.enableCalls.length = 0;
  const { configureSpaceStorage } = await import('../lib/spaceStorage');
  const { configureWorkModes, writeWindowModeId } = await import('../lib/workModes');
  localStorage.clear();
  sessionStorage.clear();
  configureSpaceStorage(null);
  configureWorkModes({ homeId: 'main' });
  writeWindowModeId('work');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});


describe('work surfaces — visual proof', () => {
  it('mode menu: this window only, other windows unaffected', async () => {
    const { useWorkModes } = await import('../lib/workModeCatalog');
    const client = { listWorkPresets: fixture.listWorkPresets, enableWorkPreset: fixture.enableWorkPreset } as never;
    function Harness() {
      const cat = useWorkModes(client);
      return <WorkModeMenu catalog={cat} onSetup={() => {}} />;
    }
    await mount(<Harness />);
    await act(async () => { container.querySelector('[data-work-mode-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await shoot('mode-menu', 780, 560);
    expect(container.querySelectorAll('[data-work-mode-option]').length).toBe(2);
    expect(container.textContent).toContain('Applies to this window');
  });

  it('enable sheet: real gaps, one action, prerequisite in the same step', async () => {
    const client = { enableWorkPreset: fixture.enableWorkPreset } as never;
    await mount(<WorkSetupSheet mode={workItem as never} client={client} onClose={() => {}} onEnabled={() => {}} />);
    // Dialog renders into a portal on document.body, not into the mount node.
    await shoot('work-setup', 700, 900);
    expect(document.querySelector('[data-work-prerequisite]')).not.toBeNull();

    await act(async () => { document.querySelector('[data-work-setup-confirm]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // One action carries the whole setup, including the prerequisite consent.
    expect(fixture.enableCalls).toEqual([{ id: 'work', prerequisites: true }]);
  });

  it('work home: a page you can act on', async () => {
    await mountInShell(<WorkPage onSetupMode={() => {}} enabled />);
    await shoot('work-home', 1180, 780);
    await shoot('work-home-390', 390, 780);
    expect(container.querySelectorAll('[data-work-task]').length).toBe(4);
    expect(container.querySelector('[data-proof-composer]')).not.toBeNull();
  });

  it('work home at a narrow width', async () => {
    await mountInShell(<WorkPage onSetupMode={() => {}} enabled />);
  });

  it('preview: a rendered Office page, with page navigation', async () => {
    fixture.response = 'office';
    await mount(<DocumentTabView source={{ kind: 'workspace', path: 'C:/Documents/renewal-deck.pptx' }} sessionId="s1" client={PROOF_CLIENT} />);
    await shoot('preview-office', 780, 900);
    const node = container.querySelector('[data-preview-document]');
    expect(node?.getAttribute('data-fidelity')).toBe('rendered');
    expect(node?.getAttribute('data-renderer')).toBe('officecli');
    expect(container.textContent).toContain('Page 2 of 14');
  });

  it('preview: a sheet answer shows the sheet control', async () => {
    fixture.response = 'sheet';
    await mount(<DocumentTabView source={{ kind: 'workspace', path: 'C:/Documents/headcount.xlsx' }} sessionId="s1" client={PROOF_CLIENT} />);
    expect(container.querySelector('[data-preview-document]')?.getAttribute('data-format')).toBe('xlsx');
  });

  it('preview: an attached PDF reaches the page canvas, not a workspace reader', async () => {
    fixture.response = 'attachment';
    await mount(<DocumentTabView source={{ kind: 'session-media', fileId: 'file-9', name: 'supplier-terms.pdf' }} sessionId="s1" client={PROOF_CLIENT} />);
    await shoot('preview-attachment-pdf', 780, 900);
    const node = container.querySelector('[data-preview-document]');
    expect(node?.getAttribute('data-renderer')).toBe('browser-pdf');
    // The source branch is the attachment, and the canvas got the server's URL.
    expect(node?.getAttribute('data-source')).toBe('session-media');
    expect(container.querySelector('[data-proof-pdf-canvas]')).not.toBeNull();
    // The canvas is handed the server's asset path, which the client reads over
    // the authenticated connection — never a host path or a bare page fetch.
    const assetUrl = container.querySelector('[data-proof-pdf-canvas]')?.getAttribute('data-asset-url');
    expect(assetUrl).toContain('/api/sessions/s1/document-preview/assets/');
    expect(assetUrl).not.toContain('C:/');
  });

  it('preview: a PDF page count the server did not send is learned from the renderer', async () => {
    fixture.response = 'pdfNoCount';
    await mount(<DocumentTabView source={{ kind: 'workspace', path: 'C:/Documents/manual.pdf' }} sessionId="s1" client={PROOF_CLIENT} />);
    // Before the renderer reports, the counter must not claim an end it cannot see.
    expect(container.querySelector('[data-preview-page-control]')?.textContent).toContain('Page 1 of …');
    await act(async () => { container.querySelector('[data-proof-pdf-count]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Once known, the last page is reachable rather than an endless next button.
    expect(container.querySelector('[data-preview-page-control]')?.textContent).toContain('Page 1 of 7');
    const forward = container.querySelector('[data-preview-page-control] button:last-of-type') as HTMLButtonElement | null;
    expect(forward?.disabled).toBe(false);
  });

  it('preview: CSV is labelled as the file text, not a page', async () => {
    fixture.response = 'csv';
    await mount(<DocumentTabView source={{ kind: 'workspace', path: 'C:/Documents/vendors.csv' }} sessionId="s1" client={PROOF_CLIENT} />);
    await shoot('preview-csv', 780, 620);
    expect(container.querySelector('[data-preview-fidelity="source"]')).not.toBeNull();
    expect(container.textContent).toContain('not as a laid-out page');
  });

  it('preview: a missing renderer installs just that one program, with no mode involved', async () => {
    fixture.response = 'missing';
    await mount(<DocumentTabView source={{ kind: 'workspace', path: 'C:/Documents/contract.docx' }} sessionId="s1" client={PROOF_CLIENT} />);
    await shoot('preview-missing', 780, 560);
    // One button, and it installs the prerequisite the recovery names.
    const button = container.querySelector('[data-install-dependency]');
    expect(button?.getAttribute('data-prerequisite')).toBe('officecli');
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(fixture.enableCalls).toEqual([{ id: 'kiki-office', prerequisites: 'officecli' }]);
  });
});
