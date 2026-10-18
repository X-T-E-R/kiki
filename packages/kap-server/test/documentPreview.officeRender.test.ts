import type { Scope } from '@kiki/agent-core-v2';
import { IHostProcessService } from '@kiki/agent-core-v2/os/interface/hostProcess';
import { documentPreviewResponseSchema } from '@kiki/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runOfficeCli = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const stat = vi.hoisted(() => vi.fn());

vi.mock('../src/services/documentPreview/officeCliPreview', async () => {
  const actual = await vi.importActual<typeof import('../src/services/documentPreview/officeCliPreview')>('../src/services/documentPreview/officeCliPreview');
  return { ...actual, runOfficeCli };
});
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile, stat };
});

import { renderOfficeDocument, toWireResponse } from '../src/routes/documentPreview';

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const core = {
  accessor: {
    get: (service: unknown) => {
      if (service === IHostProcessService) return { spawn: vi.fn() };
      throw new Error('settings unavailable');
    },
  },
} as unknown as Scope;
const signal = new AbortController().signal;

beforeEach(() => {
  runOfficeCli.mockReset();
  readFile.mockReset();
  stat.mockReset();
  readFile.mockResolvedValue(png);
  stat.mockResolvedValue({ isFile: () => true, size: png.byteLength });
});

describe('office document render', () => {
  it('asks OfficeCLI for an html screenshot and keeps the slide count on the wire', async () => {
    runOfficeCli.mockImplementation(async (_binary: string, args: readonly string[]) => {
      if (args.includes('stats')) return { code: 0, stdout: '{"success":true,"data":{"slides":3}}', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const rendered = await renderOfficeDocument(core, { path: 'C:/docs/deck.pptx', page: 1, signal });
    expect(rendered.pageCount).toBe(3);
    expect(rendered.mime).toBe('image/png');
    const screenshot = runOfficeCli.mock.calls.find((call) => (call[1] as readonly string[]).includes('screenshot'));
    expect(screenshot?.[1]).toEqual(['view', 'C:/docs/deck.pptx', 'screenshot', '--out', expect.stringMatching(/preview\.png$/u), '--render', 'html', '--page', '1']);
    const wire = documentPreviewResponseSchema.parse(toWireResponse({
      kind: 'ready', format: 'pptx', fidelity: 'rendered', renderer: 'officecli',
      source: { kind: 'workspace', name: 'deck.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 4 },
      navigation: { kind: 'page', page: 1, pageCount: rendered.pageCount },
      assets: [{ assetId: 'asset', bytes: png, mime: 'image/png' }],
      readOnly: true,
    }, 'session'));
    expect(wire).toMatchObject({ kind: 'ready', navigation: { kind: 'page', page: 1, page_count: 3 } });
  });

  it('lists worksheet names and does not force the html renderer on a sheet', async () => {
    runOfficeCli.mockImplementation(async (_binary: string, args: readonly string[]) => {
      if (args.includes('outline')) return { code: 0, stdout: '├── "Sheet1" (1 rows × 1 cols)\n└── "Totals" (1 rows × 1 cols)\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const rendered = await renderOfficeDocument(core, { path: 'C:/docs/book.xlsx', page: 1, sheet: 'Totals', signal });
    expect(rendered.sheets).toEqual(['Sheet1', 'Totals']);
    const screenshot = runOfficeCli.mock.calls.find((call) => (call[1] as readonly string[]).includes('screenshot'))?.[1] as readonly string[];
    expect(screenshot).toContain('--range');
    expect(screenshot).toContain('Totals!A1:Z50');
    expect(screenshot).not.toContain('--render');
    const wire = documentPreviewResponseSchema.parse(toWireResponse({
      kind: 'ready', format: 'xlsx', fidelity: 'rendered', renderer: 'officecli',
      source: { kind: 'workspace', name: 'book.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4 },
      navigation: { kind: 'sheet', sheet: 'Totals', sheets: rendered.sheets, sheetCount: rendered.sheetCount },
      assets: [{ assetId: 'asset', bytes: png, mime: 'image/png' }],
      readOnly: true,
    }, 'session'));
    expect(wire).toMatchObject({ navigation: { kind: 'sheet', sheet: 'Totals', sheets: ['Sheet1', 'Totals'], sheet_count: 2 } });
  });

  it('reports a missing binary instead of rendering, and rejects a page past the slide count', async () => {
    runOfficeCli.mockResolvedValue({ code: -1, stdout: '', stderr: 'not found', spawnError: 'ENOENT' });
    await expect(renderOfficeDocument(core, { path: 'C:/docs/deck.pptx', page: 1, signal })).rejects.toMatchObject({ dependency: 'officecli', pluginState: 'enabled' });
    runOfficeCli.mockImplementation(async (_binary: string, args: readonly string[]) => (
      args.includes('stats') ? { code: 0, stdout: '{"data":{"slides":1}}', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    await expect(renderOfficeDocument(core, { path: 'C:/docs/deck.pptx', page: 2, signal })).rejects.toMatchObject({ reason: 'page_out_of_range' });
    expect(runOfficeCli.mock.calls.some((call) => (call[1] as readonly string[]).includes('screenshot'))).toBe(false);
  });
});
