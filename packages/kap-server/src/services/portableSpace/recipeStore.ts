import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { recipeSummarySchema } from '@kiki/protocol';
import { z } from 'zod';
import { safePortablePath } from './tarArchive';

export const RECIPE_STORE = 'store/recipes/';
export const RECIPE_INSTALLATIONS = `${RECIPE_STORE}installations`;
const locatorPrefix = '$KIKI_HOME/recipes/';
const installationSchema = z.object({
  summary: recipeSummarySchema,
  history: z.array(z.string()),
  editable: z.boolean(),
  checked_at: z.number().optional(),
  trustedHooks: z.array(z.string()).optional(),
});
export type PortableRecipeInstallation = z.infer<typeof installationSchema>;

export function readRecipeInstallations(bytes: Buffer): Record<string, PortableRecipeInstallation> {
  const records = z.record(z.string(), installationSchema).parse(JSON.parse(bytes.toString('utf8')));
  for (const [id, entry] of Object.entries(records)) {
    if (!/^[\w-]+$/.test(id) || entry.summary.installation_id !== id) throw new Error('Invalid portable Recipe installation ID');
  }
  return records;
}

export function installBytes(records: Record<string, PortableRecipeInstallation>): Buffer {
  return Buffer.from(JSON.stringify(records));
}

export function portableRecipeLocator(locator: string, home: string): string {
  const normalized = locator.replaceAll('\\', '/');
  const prefix = `${home.replaceAll('\\', '/').replace(/\/$/, '')}/recipes/`;
  const fold = process.platform === 'win32' || /^[a-z]:\//i.test(prefix);
  if (!(fold ? normalized.toLowerCase().startsWith(prefix.toLowerCase()) : normalized.startsWith(prefix))) return locator;
  return `${locatorPrefix}${safePortablePath(normalized.slice(prefix.length))}`;
}

export async function hydrateRecipeInstallation(entry: PortableRecipeInstallation, home: string, trustedHooks?: string[]): Promise<PortableRecipeInstallation> {
  const source = entry.summary.source;
  let locator = source.locator;
  const normalized = locator.replaceAll('\\', '/');
  const explicit = /^(?:\$\{KIKI_HOME\}\/|\$KIKI_HOME\/)?recipes\/(.+)$/u.exec(normalized);
  const absolute = /^(?:[a-z]:\/|\/).*\/recipes\/(.+)$/iu.exec(normalized);
  const rel = explicit?.[1] ?? absolute?.[1];
  if (rel) {
    const candidate = join(home, 'recipes', ...safePortablePath(rel).split('/'));
    const present = explicit || await lstat(candidate).then((stat) => stat.isFile(), (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (present) locator = candidate;
  }
  return { ...entry, summary: { ...entry.summary, source: { ...source, locator } }, trustedHooks };
}
