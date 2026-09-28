import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseManifest } from '#/app/plugin/manifest';
import { panelDocument } from '#/app/plugin/panelDocument';

async function makePanel() {
  const root = await mkdtemp(path.join(tmpdir(), 'kiki-panel-document-'));
  await writeFile(path.join(root, 'kimi.plugin.json'), JSON.stringify({
    name: 'panel-fixture', 'x-kiki': { engines: { kiki: '^0.4.0' }, permissions: { uiPanel: true },
      panels: [{ schemaVersion: 1, id: 'demo', label: 'Demo', slot: 'sidebar', path: './panel.html', assets: ['./ui.js'] }],
    },
  }));
  await writeFile(path.join(root, 'panel.html'), '<!doctype html><html><head><title>Panel</title></head><body><script src="./ui.js"></script></body></html>');
  await writeFile(path.join(root, 'ui.js'), 'window.panelReady=true;');
  return root;
}

describe('sandboxed panel document', () => {
  it('inlines only declared local resources and puts CSP first', async () => {
    const root = await makePanel();
    try {
      const parsed = await parseManifest(root);
      expect(parsed.diagnostics).toEqual([]);
      const html = await panelDocument(root, parsed.manifest!.kiki!.panels![0]!);
      expect(html).toContain('<meta http-equiv="Content-Security-Policy"');
      expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<title>'));
      expect(html).toContain('<script src="data:text/javascript;base64,');
      expect(html).not.toContain('src="./ui.js"');
      await writeFile(path.join(root, 'panel.html'), '<script src="https://example.com/injected.js"></script>');
      await expect(panelDocument(root, parsed.manifest!.kiki!.panels![0]!)).rejects.toThrow('undeclared external asset');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
