import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_PLUGINS_ROOT = resolve(import.meta.dirname, '../../../plugins');
const DEFAULT_OUTPUT = resolve(import.meta.dirname, '../src/app/plugin/officialPlugins.metadata.json');
const ENGINE_VERSION = '0.4.0';

/** Project the checked-in catalog into release metadata, without network or payload reads. */
export async function generateOfficialPluginMetadata(pluginsRoot) {
  const catalog = JSON.parse(await readFile(resolve(pluginsRoot, 'marketplace.json'), 'utf8'));
  if (!Array.isArray(catalog.plugins)) throw new Error('Marketplace must contain a plugins array');
  const official = [];
  const curated = [];
  const seen = new Set();
  for (const entry of catalog.plugins) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.trim() === '') {
      throw new Error('Marketplace entry must contain an id');
    }
    if (seen.has(entry.id)) throw new Error(`Duplicate marketplace plugin id: ${entry.id}`);
    seen.add(entry.id);
    if (entry.tier !== 'official' && entry.tier !== 'curated') {
      throw new Error(`Marketplace entry ${entry.id} must declare official or curated tier`);
    }
    const source = entry.publishedSource ?? entry.source;
    let url;
    try {
      url = new URL(source);
    } catch {
      throw new Error(`Marketplace entry ${entry.id} must have an HTTPS published source`);
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new Error(`Marketplace entry ${entry.id} must have an HTTPS published source`);
    }
    if (entry.tier === 'official' && (!url.pathname.endsWith('.zip') || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? ''))) {
      throw new Error(`Official marketplace entry ${entry.id} must have a published ZIP and sha256`);
    }
    const projected = {
      id: entry.id,
      tier: entry.tier,
      version: entry.version,
      displayName: entry.displayName ?? entry.id,
      description: entry.description,
      homepage: entry.homepage,
      keywords: entry.keywords,
      relevance: entry.relevance,
      group: entry.group,
      icon: entry.icon,
      engines: entry.engines,
      license: entry.license,
      author: entry.author,
      source,
      sha256: entry.sha256,
      localizations: entry.localizations,
    };
    (entry.tier === 'official' ? official : curated).push(projected);
  }
  official.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { version: 1, engineVersion: ENGINE_VERSION, official, curated };
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = await generateOfficialPluginMetadata(resolve(process.argv[2] ?? DEFAULT_PLUGINS_ROOT));
  await writeFile(resolve(process.argv[3] ?? DEFAULT_OUTPUT), JSON.stringify(metadata, null, 2) + '\n');
  process.stdout.write(`Bundled metadata for ${metadata.official.length} official and ${metadata.curated.length} curated plugins\n`);
}
