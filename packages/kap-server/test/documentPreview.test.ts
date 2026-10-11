import { describe, expect, it } from 'vitest';

import {
  DocumentPreviewDependencyError,
  DocumentPreviewService,
  type DocumentPreviewFile,
} from '../src/services/documentPreview/documentPreviewService';

const signal = new AbortController().signal;

function file(name: string, bytes: Uint8Array, mediaType = 'application/octet-stream'): DocumentPreviewFile {
  return {
    sourceKind: 'workspace', name, mediaType, size: bytes.byteLength,
    stream: async function* (range) {
      const start = range?.start ?? 0;
      const end = range?.end ?? bytes.byteLength - 1;
      yield bytes.subarray(start, end + 1);
    },
  };
}

describe('document preview engine', () => {
  it('returns bounded source windows for text and CSV without reading the whole file', async () => {
    const bytes = new TextEncoder().encode('a,b\n1,2\n3,4\n');
    let readBytes = 0;
    const source: DocumentPreviewFile = {
      ...file('table.csv', bytes, 'text/csv'),
      stream: async function* (range) {
        const start = range?.start ?? 0;
        const end = range?.end ?? bytes.length - 1;
        const selected = bytes.subarray(start, end + 1);
        readBytes += selected.length;
        yield selected;
      },
    };
    const result = await new DocumentPreviewService().preview('session', source, { maxBytes: 6 }, signal);
    expect(result).toMatchObject({ kind: 'text', format: 'csv', fidelity: 'source', content: 'a,b\n1,', truncated: true, nextOffset: 6, readOnly: true });
    expect(readBytes).toBe(7);
  });

  it('keeps large text range reads bounded beyond the source guard and allows large offsets', async () => {
    const offset = 2 * 1024 * 1024 * 1024;
    const bytes = new TextEncoder().encode('tail text');
    let requested: { readonly start: number; readonly end: number } | undefined;
    const source: DocumentPreviewFile = {
      sourceKind: 'workspace', name: 'huge.csv', mediaType: 'text/csv', size: offset + bytes.byteLength + 100,
      stream: async function* (range) {
        requested = range;
        yield bytes;
      },
    };
    const result = await new DocumentPreviewService().preview('session', source, { offset, maxBytes: 4 }, signal);
    expect(result).toMatchObject({ kind: 'text', format: 'csv', content: 'tail', offset, nextOffset: offset + 4, truncated: true, readOnly: true });
    expect(requested).toEqual({ start: offset, end: offset + 4 });
    const utf8 = new TextEncoder().encode('中A英B');
    const windows: string[] = [];
    let cursor = 0;
    for (let index = 0; index < 8; index += 1) {
      const window = await new DocumentPreviewService().preview('session', file('mixed.csv', utf8, 'text/csv'), { offset: cursor, maxBytes: 2 }, signal);
      if (window.kind !== 'text') throw new Error('expected bounded UTF-8 text');
      windows.push(window.content);
      if (window.nextOffset === undefined) break;
      cursor = window.nextOffset;
    }
    expect(windows.join('')).toBe('中A英B');
  });

  it('falls back to a real browser PDF asset when Poppler is unavailable', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\n%browser-rendered-source\n');
    const service = new DocumentPreviewService({ pdftoppmPath: 'missing-pdftoppm-for-test', pdfinfoPath: 'missing-pdfinfo-for-test' });
    const result = await service.preview('session', file('guide.pdf', bytes, 'application/pdf'), { page: 1001 }, signal);
    expect(result).toMatchObject({ kind: 'ready', format: 'pdf', renderer: 'browser-pdf', fidelity: 'rendered', navigation: { kind: 'page', page: 1001 }, readOnly: true });
    if (result.kind !== 'ready') throw new Error('expected browser PDF result');
    expect(result.assets[0]?.mime).toBe('application/pdf');
    expect(service.readAsset('other-session', result.assets[0]!.assetId)).toBeUndefined();
    expect(service.readAsset('session', result.assets[0]!.assetId)?.bytes).toEqual(bytes);
  });

  it('evicts least-recently-used assets by bytes before the count cap', async () => {
    const service = new DocumentPreviewService({
      pdftoppmPath: 'missing-pdftoppm-for-test',
      pdfinfoPath: 'missing-pdfinfo-for-test',
      assetByteBudget: 8,
    });
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
    const first = await service.preview('session', file('first.pdf', bytes, 'application/pdf'), {}, signal);
    const second = await service.preview('session', file('second.pdf', bytes, 'application/pdf'), {}, signal);
    if (first.kind !== 'ready' || second.kind !== 'ready') throw new Error('expected browser PDF assets');
    const firstId = first.assets[0]!.assetId;
    const secondId = second.assets[0]!.assetId;
    expect(service.readAsset('session', firstId)?.bytes).toEqual(bytes);
    const third = await service.preview('session', file('third.pdf', bytes, 'application/pdf'), {}, signal);
    if (third.kind !== 'ready') throw new Error('expected browser PDF asset');
    expect(service.readAsset('session', firstId)?.bytes).toEqual(bytes);
    expect(service.readAsset('session', secondId)).toBeUndefined();
    expect(service.readAsset('session', third.assets[0]!.assetId)?.bytes).toEqual(bytes);
  });

  it('uses OfficeCLI output as a rendered read-only asset and surfaces dependency recovery', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 32 }, () => 0)]);
    const rendered = new DocumentPreviewService({ renderOffice: async (request) => {
      expect(request.signal).toBe(signal);
      const xlsx = request.path.endsWith('.xlsx');
      if (!xlsx) expect(request.page).toBe(2);
      return { bytes: png, mime: 'image/png', page: xlsx ? undefined : 2, pageCount: xlsx ? undefined : 4, sheets: xlsx ? ['Sheet1', 'Sheet2'] : undefined, sheet: xlsx ? request.sheet : undefined };
    } });
    const result = await rendered.preview('session', file('report.docx', new Uint8Array([1, 2, 3]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), { page: 2 }, signal);
    expect(result).toMatchObject({ kind: 'ready', format: 'docx', renderer: 'officecli', navigation: { kind: 'page', page: 2, pageCount: 4 } });
    const sheetResult = await rendered.preview('session', file('table.xlsx', new Uint8Array([1, 2, 3]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), { sheet: 'Sheet2' }, signal);
    expect(sheetResult).toMatchObject({ kind: 'ready', format: 'xlsx', navigation: { kind: 'sheet', sheet: 'Sheet2', sheets: ['Sheet1', 'Sheet2'], sheetCount: 2 } });

    const notInstalled = new DocumentPreviewService({ renderOffice: async () => {
      throw new DocumentPreviewDependencyError('officecli', 'Office plugin is not installed.', 'not-installed');
    } });
    await expect(notInstalled.preview('session', file('report.docx', new Uint8Array([1]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), {}, signal)).resolves.toMatchObject({
      kind: 'missing_dependency', dependency: 'officecli', recovery: { kind: 'install-prerequisite', pluginId: 'kiki-office', prerequisiteId: 'officecli', consentRequired: true, pluginState: 'not-installed' },
    });
    const disabled = new DocumentPreviewService({ renderOffice: async () => {
      throw new DocumentPreviewDependencyError('officecli', 'Office plugin is disabled.', 'disabled');
    } });
    await expect(disabled.preview('session', file('report.docx', new Uint8Array([1]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), {}, signal)).resolves.toMatchObject({
      kind: 'missing_dependency', dependency: 'officecli', recovery: { kind: 'install-prerequisite', pluginId: 'kiki-office', prerequisiteId: 'officecli', consentRequired: true, pluginState: 'disabled' },
    });
  });

  it('rejects binary content in a text-labelled source instead of showing bytes as text', async () => {
    const result = await new DocumentPreviewService().preview('session', file('notes.txt', Uint8Array.from([0, 1, 2, 3]), 'text/plain'), {}, signal);
    expect(result).toMatchObject({ kind: 'unsupported', reason: 'binary_content', recovery: { kind: 'download-original' }, readOnly: true });
  });
});
