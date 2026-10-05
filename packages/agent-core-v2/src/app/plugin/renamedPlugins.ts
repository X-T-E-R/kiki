/**
 * Plugin renames the host applies to an existing installation.
 *
 * A plugin id is part of a user's state: the managed directory, the installed
 * record, its settings under `pluginSettings`, its data directory and the
 * runtime tool names all derive from it. Renaming a package therefore has to
 * carry the installation forward, or the user ends up with the old copy
 * installed next to the new one and two sets of settings for one capability.
 *
 * The rule is deliberately narrow: an id is renamed only when the new name is
 * the same package under a new name. Behaviour, manifest, permissions and
 * settings schema are unchanged, so nothing is migrated field by field and
 * nothing is guessed.
 */

/** Old id → current id. Remove an entry once no supported release carries the old id. */
export const RENAMED_PLUGIN_IDS: Readonly<Record<string, string>> = {
  'kiki-documents': 'kiki-extract',
};

export function currentPluginId(id: string): string {
  return RENAMED_PLUGIN_IDS[id.toLowerCase()] ?? id.toLowerCase();
}

/**
 * The install id a new package claims, resolved through the rename table.
 * Installing the renamed package replaces the old installation rather than
 * appearing beside it.
 */
export function resolveInstalledPluginId(manifestName: string): string {
  return currentPluginId(manifestName);
}
