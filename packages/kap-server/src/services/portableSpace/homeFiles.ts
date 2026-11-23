import { nbSearchManagedCredentialsSchema } from '@kiki/agent-core-v2/app/nbSearch/managedCredentials';
import { installBytes, portableRecipeLocator, readRecipeInstallations, RECIPE_INSTALLATIONS } from './recipeStore';
import { checkedPath, missing, readBounded, readTree } from './spaceFiles';
import { encodeToml, PLAIN } from './treeProjection';

export const GUI_CREDENTIALS = 'secrets/nb-search/gui-credentials.json';

export function readGuiCredentials(bytes: Buffer) {
  try {
    return nbSearchManagedCredentialsSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Invalid managed nb-search credential document');
  }
}

export async function readHomeFiles(home: string, osHome: string, includeCredentials: boolean): Promise<Map<string, Buffer>> {
  const files = await readTree(home, true, (path) => !/^(?:sessions|memories)(?:\/|$)/.test(path), osHome);
  const installations = files.get(RECIPE_INSTALLATIONS);
  if (installations) {
    const records = readRecipeInstallations(installations);
    for (const entry of Object.values(records)) {
      const source = entry.summary.source;
      source.locator = portableRecipeLocator(source.locator, home);
      delete entry.trustedHooks;
    }
    files.set(RECIPE_INSTALLATIONS, installBytes(records));
  }
  if (includeCredentials) {
    const guiCredentials = await missing(readBounded(await checkedPath(home, GUI_CREDENTIALS)));
    if (guiCredentials) {
      const { slots } = readGuiCredentials(guiCredentials);
      if (Object.keys(slots).length > 0) files.set(PLAIN, encodeToml({ nb_search_gui: slots }));
    }
  }
  return files;
}
