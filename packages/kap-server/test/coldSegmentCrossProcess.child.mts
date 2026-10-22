import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = process.argv.at(-1) ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await writeFile(join(scratch, 'boot'), String(process.pid));
  const wirePath = (await readFile(join(scratch, 'wire-path.txt'), 'utf8')).trim();
  const expected = await readFile(wirePath);
  const logicalMod = await import(pathToFileURL(join(repo, 'packages/kap-server/src/services/history/logicalWireRead.ts')).href);
  await writeFile(join(scratch, 'history-loaded'), '1');
  const exportMod = await import(pathToFileURL(join(repo, 'packages/agent-core-v2/src/app/sessionExport/file-source.ts')).href);
  await writeFile(join(scratch, 'export-loaded'), '1');
  const logical = await logicalMod.openLogicalWire(wirePath);
  const zip = await exportMod.openExportZipSource(wirePath);
  if (logical === undefined) throw new Error('history logical wire did not open');
  await writeFile(join(scratch, 'ready'), JSON.stringify({ pid: process.pid }));
  const started = Date.now();
  while (!await exists(join(scratch, 'go'))) {
    if (Date.now() - started > 90_000) throw new Error('reader timed out waiting to read');
    await sleep(20);
  }
  let history = 'unread';
  let exported = 'unread';
  try {
    const bytes = await logical.readAt(0, expected.byteLength);
    history = Buffer.from(bytes).equals(expected) ? 'original' : `other:${bytes.byteLength}`;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    history = `throw:${code}:${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const parts: Buffer[] = [];
    for await (const chunk of zip.stream) parts.push(Buffer.from(chunk));
    const bytes = Buffer.concat(parts);
    exported = bytes.equals(expected) ? 'original' : `other:${bytes.byteLength}`;
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    exported = `throw:${code}:${error instanceof Error ? error.message : String(error)}`;
  } finally {
    logical.close();
    await zip.close();
  }
  const resultPath = join(scratch, 'result');
  await writeFile(`${resultPath}.tmp`, JSON.stringify({ history, exported }));
  await rename(`${resultPath}.tmp`, resultPath);
}

await main();
