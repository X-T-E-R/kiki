import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { extractDocument } from '../lib/documents.mjs';
import { definition } from '../lib/definitions.mjs';
import { loadExtract } from '../lib/runtime.mjs';
import { smallPdf } from './fixtures.mjs';

let workspace;
const context = () => ({ workspaceRoot: workspace, signal: new AbortController().signal });
const result = async (args, ctx = context()) => JSON.parse((await extractDocument(args, ctx)).output);
before(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'kiki-documents-unit-'));
  await writeFile(path.join(workspace, 'source.txt'), '# Document proof\nThe answer is 42.\n');
  await writeFile(path.join(workspace, 'source.pdf'), smallPdf());
  await writeFile(path.join(workspace, 'scan.pdf'), smallPdf(null));
});
after(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

test('manifest agrees with tool and loads the bundled standard public API', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, [definition]);
  const api = await loadExtract();
  assert.equal((await api.extract({ text: 'proof' })).markdown, 'proof');
  const html = await api.extract({ text: '<html><body><article><h1>HTML proof</h1><p>A readable local article preserves its meaning and content for the model.</p><script>BAD_SCRIPT()</script></article></body></html>', format: 'html' });
  assert.equal(html.engine, 'defuddle');
  assert.match(html.markdown, /HTML proof/);
  assert.doesNotMatch(html.markdown, /BAD_SCRIPT/);
});

test('saves real text, provenance and full artifact while preview is explicitly truncated', async () => {
  const data = await result({ file: 'source.txt', outputDir: 'nested/text', previewChars: 5 });
  assert.equal(data.status, 'succeeded');
  assert.equal(data.preview, '# Doc');
  assert.equal(data.previewTruncated, true);
  assert.equal(data.artifactTruncated, false);
  assert.match(await readFile(data.markdownPath, 'utf8'), /The answer is 42/);
  assert.equal(data.source.value, path.join(workspace, 'source.txt'));
  assert.deepEqual(JSON.parse(await readFile(data.metadataPath, 'utf8')).warnings, []);
  assert.equal((await result({ file: 'source.txt', outputDir: 'nested/text' })).code, 'OUTPUT_EXISTS');
  assert.match(await readFile(data.markdownPath, 'utf8'), /42/);
  assert.match(await readFile(path.join(workspace, 'source.txt'), 'utf8'), /42/);
});

test('rejects unauthorized upload, missing local dependency, empty content and unsupported format', async () => {
  assert.equal((await result({ file: 'source.pdf', outputDir: 'cloud', engine: 'mineru' })).code, 'UPLOAD_NOT_AUTHORIZED');
  assert.equal((await result({ file: 'source.pdf', outputDir: 'missing-python' }, { ...context(), settings: { pythonPath: 'nonexistent-documents-python' } })).code, 'LOCAL_DEPENDENCY_MISSING');
  await writeFile(path.join(workspace, 'empty.txt'), '   \n');
  assert.equal((await result({ file: 'empty.txt', outputDir: 'empty' })).code, 'EMPTY_CONTENT');
  await writeFile(path.join(workspace, 'source.doc'), 'legacy');
  assert.equal((await result({ file: 'source.doc', outputDir: 'legacy' })).code, 'FORMAT_UNSUPPORTED');
  assert.equal((await result({ file: 'source.txt', outputDir: '../escape' })).code, 'PATH_OUTSIDE_WORKSPACE');
  const pre = { ...context(), signal: AbortSignal.abort(new Error('stop')) };
  assert.equal((await result({ file: 'source.txt', outputDir: 'cancelled' }, pre)).code, 'CANCELLED');
});

test('only resolves an explicit package root; missing/mismatched packages fail closed', async () => {
  await assert.rejects(loadExtract(path.join(workspace, 'missing-package')), { code: 'DEPENDENCY_MISSING' });
  await mkdir(path.join(workspace, 'wrong-package'));
  await writeFile(path.join(workspace, 'wrong-package/package.json'), JSON.stringify({ name: '@nb-corp/nb-extract', version: '9.0.0' }));
  await assert.rejects(loadExtract(path.join(workspace, 'wrong-package')), { code: 'VERSION_MISMATCH' });
});

test('optional real PDF text and image-only negative', { skip: !process.env.NB_EXTRACT_TEST_PYTHON }, async () => {
  const ctx = { ...context(), settings: { pythonPath: process.env.NB_EXTRACT_TEST_PYTHON } };
  const data = await result({ file: 'source.pdf', outputDir: 'pdf' }, ctx);
  assert.equal(data.status, 'succeeded');
  assert.equal(data.engine, 'markitdown');
  assert.match(await readFile(data.markdownPath, 'utf8'), /Readable PDF extraction proof/);
  assert.ok(data.warnings.some((warning) => warning.includes('no assets')));
  assert.deepEqual(data.assets, []);
  assert.equal((await result({ file: 'scan.pdf', outputDir: 'scan' }, ctx)).code, 'EMPTY_CONTENT');
});
