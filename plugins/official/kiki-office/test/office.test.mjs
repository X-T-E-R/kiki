import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test, before, after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOfficeCore } from '../lib/office.mjs';
import { OFFICECLI_VERSION, CHECKSUMS_SHA256, findBinary, parseChecksum, installPinnedBinary, runProcess } from '../lib/binary.mjs';
import { guardPackage } from '../lib/package-guard.mjs';
import { definitions } from '../lib/definitions.mjs';

const root = path.dirname(import.meta.dirname);
let directory;
let binary;
let core;
before(async () => {
  directory = await mkdtemp(path.join(root, '.tmp-office-'));
  binary = process.env.OFFICECLI_TEST_BINARY;
  core = createOfficeCore({ scope: { workspaceRoot: directory, binaryPath: binary } });
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const run = (name, args, context) => core.run(name, args, context);
const yes = async (name, args) => {
  const result = await run(name, args);
  assert.equal(result.success, true, JSON.stringify(result.error));
  return result.data;
};
const no = async (name, args, code) => {
  const result = await run(name, args);
  assert.equal(result.success, false, `Expected ${code}; got ${JSON.stringify(result)}`);
  assert.equal(result.error.code, code);
  assert.ok(result.error.suggestion);
};

void test('manifest and SDK tool contract stay synchronized and descriptions fit budget', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'kimi.plugin.json'), 'utf8'));
  assert.deepEqual(manifest['x-kiki'].tools, definitions);
  assert.equal(definitions.length, 9);
  for (const definition of definitions) {
    assert.ok(definition.description.length < 600);
    assert.equal(definition.disclosure, 'deferred');
    assert.ok(definition.accesses.some((access) => access.kind === 'all'));
  }
});

void test('the actual plugin host runner registers all tools but rejects calls without workspace context', async () => {
  const runner = path.resolve(root, '../../../packages/agent-core-v2/src/app/plugin/hostRunner.mjs');
  const child = spawn(process.execPath, [runner, path.join(root, 'entry.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  const incoming = createInterface({ input: child.stdout });
  const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Plugin host response timed out')), 10_000);
    incoming.on('line', (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method === 'ready') send(1, 'execute', { name: 'office_create', args: { file: 'report.docx' } });
      if (message.id === 1) { clearTimeout(timeout); resolve(message); }
    });
    child.once('error', reject);
  });
  try {
    send(0, 'handshake', { version: 1 });
    const executed = await received;
    assert.equal(messages.filter((message) => message.method === 'register').length, definitions.length);
    assert.equal(JSON.parse(executed.result.output).code, 'WORKSPACE_UNAVAILABLE');
  } finally {
    child.kill();
    incoming.close();
  }
});

void test('pinned release checksums and explicit consent', async () => {
  assert.match(OFFICECLI_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(CHECKSUMS_SHA256.length, 64);
  assert.equal(parseChecksum(`a`.repeat(64) + '  officecli-win-x64.exe', 'officecli-win-x64.exe'), 'a'.repeat(64));
  await assert.rejects(installPinnedBinary({ consent: false, destination: path.join(directory, 'no.exe') }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(installPinnedBinary({ consent: true, destination: path.join(directory, 'no.exe'), fetchRelease: async () => Buffer.from('tampered') }), { code: 'CHECKSUM_INVALID' });
  await assert.rejects(findBinary({ binaryPath: process.execPath }), { code: 'VERSION_MISMATCH' });
});

void test('rejects missing engine, incompatible engine and path escapes', async () => {
  const missing = createOfficeCore({ scope: { workspaceRoot: directory }, locateBinary: async () => { throw Object.assign(new Error('Missing'), { code: 'ENGINE_MISSING', suggestion: 'Install pinned binary.' }); } });
  assert.equal((await missing.run('office_create', { file: 'missing.docx' })).error.code, 'ENGINE_MISSING');
  const mismatch = createOfficeCore({ scope: { workspaceRoot: directory }, locateBinary: async () => { throw Object.assign(new Error('Mismatch'), { code: 'VERSION_MISMATCH', suggestion: 'Install pinned binary.' }); } });
  assert.equal((await mismatch.run('office_create', { file: 'mismatch.docx' })).error.code, 'VERSION_MISMATCH');
  assert.equal((await createOfficeCore({ scope: {} }).run('office_create', { file: 'report.docx' })).error.code, 'WORKSPACE_UNAVAILABLE');
  await no('office_create', { file: '../escape.docx' }, 'PATH_OUTSIDE_WORKSPACE');
  await no('office_get', { file: 'absent.docx', path: '/' }, 'FILE_MISSING');
  await no('office_query', { file: 'absent.docx', selector: 'paragraph' }, 'FILE_MISSING');
  await no('office_view', { file: 'absent.docx' }, 'FILE_MISSING');
  await no('office_create', { file: path.join(directory, 'unknown.csv') }, 'FORMAT_UNSUPPORTED');
});

void test('Word chain, precise reads, style preservation and safe edits', async () => {
  binary = await findBinary({ binaryPath: binary });
  assert.equal((await runProcess(binary, ['--version'])).stdout.trim(), OFFICECLI_VERSION);
  const file = 'report.docx';
  await yes('office_create', { file });
  await no('office_create', { file }, 'FILE_EXISTS');
  await no('office_add', { file, parent: '/body', type: 'paragraph', props: {} }, 'ARGUMENT_INVALID');
  await yes('office_add', { file, parent: '/body', type: 'paragraph', props: { text: 'Styled title', style: 'Heading1' } });
  await yes('office_add', { file, parent: '/body', type: 'paragraph', props: { text: 'Original paragraph' } });
  const before = await runProcess(binary, ['raw', path.join(directory, file), 'word/document.xml']);
  assert.match(before.stdout, /Heading1/);
  assert.match(await yes('office_view', { file, mode: 'text' }), /Original paragraph/);
  assert.match(await yes('office_get', { file, path: '/body/p[2]' }), /Original paragraph/);
  assert.match(await yes('office_query', { file, selector: 'paragraph[style=Heading1]' }), /Styled title/);
  await yes('office_set', { file, path: '/body/p[1]', find: 'Styled title', replace: 'Revised title' });
  await yes('office_set', { file, path: '/body/p[2]', find: 'Original', replace: 'Updated' });
  assert.match(await yes('office_view', { file, mode: 'text' }), /Revised title[\s\S]*Updated paragraph/);
  const after = await runProcess(binary, ['raw', path.join(directory, file), 'word/document.xml']);
  const styledNode = before.stdout.match(/<w:pStyle w:val="Heading1"\s*\/>/)?.[0];
  assert.ok(styledNode, 'The original paragraph must contain a Heading1 style node');
  assert.equal(styledNode, after.stdout.match(/<w:pStyle w:val="Heading1"\s*\/>/)?.[0]);
  await yes('office_remove', { file, path: '/body/p[2]' });
  assert.doesNotMatch(await yes('office_view', { file, mode: 'text' }), /Updated paragraph/);
  await no('office_remove', { file, path: '/body/p[99]' }, 'not_found');
});

void test('Excel chain, bounded reads and atomic batch', async () => {
  const file = 'table.xlsx';
  await yes('office_create', { file });
  await yes('office_set', { file, path: '/Sheet1/A1', props: { value: 'Item', bold: true } });
  await yes('office_set', { file, path: '/Sheet1/A2', props: { value: 'Apple' } });
  assert.match(await yes('office_get', { file, path: '/Sheet1/A2' }), /Apple/);
  const batch = await yes('office_batch', { file, commands: [{ command: 'set', path: '/Sheet1/B2', props: { value: '12' } }] });
  assert.match(batch, /success|succeeded/i);
  const beforeRollback = await readFile(path.join(directory, file));
  const rollback = await run('office_batch', { file, commands: [
    { command: 'set', path: '/Sheet1/C2', props: { value: 'Should roll back' } },
    { command: 'remove', path: '/Sheet1/Z999' },
  ] });
  assert.equal(rollback.success, false, 'Atomic batch failure must be reported');
  assert.deepEqual(await readFile(path.join(directory, file)), beforeRollback, 'Failed batch must preserve workbook bytes');
  assert.match(await yes('office_view', { file }), /Apple/);
  const truncated = await yes('office_view', { file, maxSheetRows: 1, maxCells: 1 });
  assert.match(truncated, /> Truncated:/);
  await no('office_batch', { file, commands: [{ command: 'raw-set', part: 'x' }] }, 'ARGUMENT_INVALID');
  await no('office_set', { file, path: '/Sheet1/A2' }, 'ARGUMENT_INVALID');
});

void test('PowerPoint chain and preview fallback', async () => {
  const file = 'slides.pptx';
  await yes('office_create', { file });
  await yes('office_add', { file, parent: '/', type: 'slide', props: { title: 'Quarterly review' } });
  await yes('office_add', { file, parent: '/slide[1]', type: 'shape', props: { text: 'Result', x: '2cm', y: '5cm' } });
  assert.match(await yes('office_view', { file, mode: 'text' }), /Result/);
  assert.match(await yes('office_get', { file, path: '/slide[1]' }), /Quarterly review|Result/);
  const preview = await run('office_preview', { file }, { imageIn: false });
  assert.equal(preview.success, true);
  assert.match(preview.data.text, /outline/i);
  const visual = await run('office_preview', { file }, { imageIn: true });
  assert.equal(visual.success, true, JSON.stringify(visual.error));
  assert.match(visual.data.image, /^data:image\/png;base64,/);
  await no('office_preview', { file, mode: 'raw' }, 'ARGUMENT_INVALID');
});

void test('malformed, oversized and unknown OOXML parts fail before mutation', async () => {
  const file = path.join(directory, 'fake.docx');
  await writeFile(file, 'not a ZIP');
  await assert.rejects(guardPackage(file), { code: 'PACKAGE_INVALID' });
  await no('office_set', { file, path: '/', props: { author: 'test' } }, 'PACKAGE_INVALID');
  const zip = (name, expanded) => {
    const part = Buffer.alloc(46 + Buffer.byteLength(name));
    part.writeUInt32LE(0x02014b50, 0);
    part.writeUInt16LE(8, 10);
    part.writeUInt32LE(1, 20);
    part.writeUInt32LE(expanded, 24);
    part.writeUInt16LE(Buffer.byteLength(name), 28);
    part.write(name, 46);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(part.length, 12);
    return Buffer.concat([part, end]);
  };
  await writeFile(file, zip('word/media/unrecognized.xyz', 1));
  await assert.rejects(guardPackage(file), { code: 'UNKNOWN_BINARY_PART' });
  await writeFile(file, zip('word/document.xml', 65 * 1024 * 1024));
  await assert.rejects(guardPackage(file), { code: 'PACKAGE_LIMIT' });
});
