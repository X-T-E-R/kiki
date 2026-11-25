import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'pathe';
import { z } from 'zod';
import { canonicalHomeKey } from '#/main/launchArgs';
import { readDesktopSpaceToml } from '#/main/prefsAndUpdateService';
import type { DesktopSpace } from '#/shared/types';

const homesJsonEntrySchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
});

export class SpaceCatalog {
  private activeSpace: DesktopSpace;

  constructor(
    readonly mainHome: string,
    readonly defaultHome: string,
    initialSpace?: DesktopSpace,
  ) {
    this.activeSpace =
      initialSpace !== undefined
        ? { ...initialSpace, isPrimary: initialSpace.homeId === 'main' }
        : this.buildMainSpace();
  }

  private buildMainSpace(): DesktopSpace {
    const isDefault = canonicalHomeKey(this.mainHome) === canonicalHomeKey(this.defaultHome);
    const name = isDefault ? 'Main space' : basename(this.mainHome) || 'Main space';
    return {
      homeId: 'main',
      name,
      color: null,
      preset: null,
      path: this.mainHome,
      baseHome: null,
      credentialsShared: true,
      isPrimary: true,
    };
  }

  getActiveSpace(): DesktopSpace {
    return this.activeSpace;
  }

  setActiveSpace(space: DesktopSpace): void {
    this.activeSpace = { ...space, isPrimary: space.homeId === 'main' };
  }

  async findSpace(homeId: string): Promise<DesktopSpace> {
    if (homeId === 'main') {
      return this.buildMainSpace();
    }
    if (this.activeSpace.homeId === homeId) {
      return this.activeSpace;
    }
    const raw = await readFile(join(this.mainHome, 'homes.json'), 'utf8');
    const parsed = z.array(homesJsonEntrySchema).parse(JSON.parse(raw));
    const entry = parsed.find((item) => item.id === homeId);
    if (entry === undefined) {
      throw new Error(`Unknown space: ${homeId}`);
    }
    if (!isAbsolute(entry.path)) {
      throw new Error('Space path must be absolute');
    }
    const space = await readDesktopSpaceToml(entry.path);
    if (space === null) {
      throw new Error('Space home.toml is missing');
    }
    if (
      space.homeId !== homeId ||
      space.baseHome === null ||
      space.baseHome === undefined ||
      canonicalHomeKey(space.baseHome) !== canonicalHomeKey(this.mainHome)
    ) {
      throw new Error('Space identity or base changed since registration');
    }
    return { ...space, isPrimary: false };
  }
}
