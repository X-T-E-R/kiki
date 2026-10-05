import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { downloadZip, extractZip } from '../../src/app/plugin/archive';

const release = 'https://github.com/X-T-E-R/kiki-plugins/releases/download/plugins-20261005.3/';
const checksums = {
  'kiki-extract': '91733ccb248d31c25f35561edc4ef4d267413a1a6d638817fd589f04b8d85892',
  'kiki-media': 'b84d2eadd0ea4e4f65b68a028ca87ce08e89ff7a36311753448b587842cdb455',
  'kiki-notion': '92ac377087fe7dcd79fc32574ffaebf73bce81ea39055c20f684da9ba470b05d',
  'kiki-office': 'aaa898fdd3d9890441edb012a0bd9c915a043bfe983db54711ef401fa255f31b',
  'kiki-writing': 'ce0d412c746cf779c10ca37a72d635ec169dad88febe6c311ee92c34887054b9',
} as const;

export type OfficialPluginFixtureId = keyof typeof checksums;

const cacheRoot = resolve(import.meta.dirname, '../../../../.tmp/official-plugin-fixtures');
const pending = new Map<OfficialPluginFixtureId, Promise<Buffer>>();

async function archive(id: OfficialPluginFixtureId): Promise<Buffer> {
  const checksum = checksums[id];
  const path = join(cacheRoot, checksum + '.zip');
  const cached = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (cached !== undefined) {
    assert.equal(createHash('sha256').update(cached).digest('hex'), checksum, `Corrupt fixed plugin fixture cache: ${path}`);
    return cached;
  }
  const bytes = await downloadZip(`${release}${id}-0.1.0.zip`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum, `Fixed plugin fixture checksum mismatch: ${id}`);
  await mkdir(cacheRoot, { recursive: true });
  const temporary = await mkdtemp(join(cacheRoot, 'download-'));
  try {
    const pathToPublish = join(temporary, 'archive.zip');
    await writeFile(pathToPublish, bytes);
    await rename(pathToPublish, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return bytes;
}

export async function fixedArchive(id: OfficialPluginFixtureId): Promise<Buffer> {
  const running = pending.get(id);
  if (running !== undefined) return running;
  const task = archive(id);
  pending.set(id, task);
  try {
    return await task;
  } finally {
    pending.delete(id);
  }
}

export function officialPluginFixtureSource(id: OfficialPluginFixtureId): { source: string; sha256: string } {
  return { source: `${release}${id}-0.1.0.zip`, sha256: checksums[id] };
}

export async function prepareOfficialPluginFixtures(...ids: OfficialPluginFixtureId[]): Promise<void> {
  await Promise.all(ids.map(fixedArchive));
}

export async function officialPluginFixture(id: OfficialPluginFixtureId, destination: string): Promise<string> {
  const root = await extractZip(await fixedArchive(id), destination);
  const manifest = JSON.parse(await readFile(join(root, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, id);
  assert.equal(manifest.version, '0.1.0');
  return root;
}
