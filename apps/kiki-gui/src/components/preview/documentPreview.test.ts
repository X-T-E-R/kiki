// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { documentPreviewResponseSchema, type DocumentPreviewSource } from '@kiki/protocol';

import { I18nProvider } from '../../i18n';
import { documentSourceFor, isRenderedFidelity, navigationOf, recoveryOf, sheetsOf } from './documentPreview';
import { RendererInstall } from './RendererInstall';

const ASSET = { asset_id: 'a'.repeat(24), mime: 'image/png', url: '/api/sessions/s1/document-preview/assets/aaaaaaaaaaaaaaaaaaaaaaaa', width: 1240, height: 1754 };

function ready(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ready', format: 'pdf', fidelity: 'rendered', renderer: 'browser-pdf',
    source: { kind: 'workspace', name: 'report.pdf', media_type: 'application/pdf', size: 4096 },
    navigation: { kind: 'page', page: 1, page_count: 12 },
    assets: [ASSET], read_only: true, ...overrides,
  };
}

describe('document preview source contract', () => {
  it('builds a workspace source and a session-media source, never mixing their ids', () => {
    const workspace = documentSourceFor({ path: 'C:/docs/report.pdf', runtimeId: 'rt-1' });
    expect(workspace).toEqual({ kind: 'workspace', path: 'C:/docs/report.pdf', runtime_id: 'rt-1' });

    const attachment = documentSourceFor({ fileId: 'file-9', name: 'brief.pdf', mediaType: 'application/pdf' });
    expect(attachment).toEqual({ kind: 'session-media', file_id: 'file-9', name: 'brief.pdf', media_type: 'application/pdf' });

    // A file id is not a path and a path is not a file id: neither source may
    // grow the other's field, or the renderer would read the wrong store.
    expect('file_id' in workspace).toBe(false);
    expect('path' in attachment).toBe(false);
  });

  it('parses a browser-pdf answer and keeps the asset url the server returned', () => {
    const response = documentPreviewResponseSchema.parse(ready());
    expect(response.kind).toBe('ready');
    if (response.kind !== 'ready') throw new Error('expected ready');
    // The canvas must read this URL for a workspace file AND an attachment.
    expect(response.assets[0]?.url).toBe(ASSET.url);
    expect(response.renderer).toBe('browser-pdf');
  });

  it('parses a session-media answer and still hands back a usable asset url', () => {
    const response = documentPreviewResponseSchema.parse(ready({
      source: { kind: 'session-media', name: 'brief.pdf', media_type: 'application/pdf', size: 2048 },
    }));
    if (response.kind !== 'ready') throw new Error('expected ready');
    expect(response.source.kind).toBe('session-media');
    expect(response.assets[0]?.url).toBe(ASSET.url);
  });

  it('reports rendered fidelity apart from source text', () => {
    expect(isRenderedFidelity(documentPreviewResponseSchema.parse(ready()))).toBe(true);
    const text = documentPreviewResponseSchema.parse({
      kind: 'text', format: 'csv', fidelity: 'source',
      source: { kind: 'workspace', name: 'rows.csv', media_type: 'text/csv', size: 900 },
      encoding: 'utf-8', content: 'a,b\n1,2\n', offset: 0, truncated: false, total_bytes: 900, read_only: true,
    });
    // Source text is the file's characters, not a laid-out page, and the view
    // must be able to tell the difference.
    expect(isRenderedFidelity(text)).toBe(false);
  });

  it.each(['not-installed', 'disabled', 'enabled'] as const)('names the one install an Office document needs when the plugin is %s', (pluginState) => {
    const missing = documentPreviewResponseSchema.parse({
      kind: 'missing_dependency', dependency: 'officecli',
      source: { kind: 'workspace', name: 'deck.pptx', media_type: 'application/vnd.ms-powerpoint', size: 9000 },
      message: 'OfficeCLI is not installed.',
      recovery: { kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true, plugin_state: pluginState },
      read_only: true,
    });
    // The recovery has to say which of the three real states it is, because the
    // fix differs: install the plugin, turn it back on, or add only the program.
    expect(recoveryOf(missing)).toEqual({
      kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true, plugin_state: pluginState,
    });
  });

  it('refuses a recovery answer that does not say which state the plugin is in', () => {
    // The three states are what stop the GUI from guessing a fix from a failed
    // request, so an answer without one is not a usable contract.
    expect(() => documentPreviewResponseSchema.parse({
      kind: 'missing_dependency', dependency: 'officecli',
      source: { kind: 'workspace', name: 'deck.pptx', media_type: 'application/vnd.ms-powerpoint', size: 9000 },
      message: 'OfficeCLI is not installed.',
      recovery: { kind: 'install-prerequisite', plugin_id: 'kiki-office', prerequisite_id: 'officecli', consent_required: true },
      read_only: true,
    })).toThrow();
  });

  it('reads page and sheet navigation, and an xlsx sheet answer', () => {
    const paged = documentPreviewResponseSchema.parse(ready());
    expect(navigationOf(paged)?.kind).toBe('page');

    const sheet = documentPreviewResponseSchema.parse(ready({
      format: 'xlsx', renderer: 'officecli',
      navigation: { kind: 'sheet', sheet: 'Q3', sheet_index: 2, sheet_count: 5 },
    }));
    if (sheet.kind !== 'ready' || sheet.navigation.kind !== 'sheet') throw new Error('expected a sheet answer');
    expect(sheetsOf(sheet)).toEqual(['Q3']);
  });
});

describe('preview kind routing', () => {
  it('routes document formats to the document tab, not to binary', async () => {
    const { previewKindOf } = await import('@kiki/session-core/composer/media');
    expect(previewKindOf('C:/docs/report.pdf')).toBe('pdf');
    expect(previewKindOf('C:/docs/deck.pptx')).toBe('office');
    expect(previewKindOf('C:/docs/table.xlsx')).toBe('office');
    expect(previewKindOf('C:/docs/brief.docx')).toBe('office');
  });
});
