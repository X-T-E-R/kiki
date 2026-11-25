import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopSshProfileSchema, desktopSshProfilesResponseSchema, type DesktopSshProfile } from '@kiki/protocol';
import { writePrivateFile } from '../auth/privateFiles';

export const MAX_DESKTOP_SSH_PROFILES = 100;
const MAX_PROFILE_FILE_BYTES = 1024 * 1024;

export class DesktopSshProfileError extends Error {
  constructor(readonly reason: 'invalid' | 'unavailable' | 'too_many', message: string) {
    super(message);
    this.name = 'DesktopSshProfileError';
  }
}

export interface DesktopSshProfileStoreOptions {
  readonly filePath: string;
}

export class DesktopSshProfileStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: DesktopSshProfileStoreOptions) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readUnlocked(): Promise<DesktopSshProfile[]> {
    let raw: string;
    try {
      raw = await readFile(this.options.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new DesktopSshProfileError('unavailable', 'Cannot read SSH profiles');
    }
    if (Buffer.byteLength(raw) > MAX_PROFILE_FILE_BYTES) {
      throw new DesktopSshProfileError('invalid', 'SSH profile file exceeds the size limit');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DesktopSshProfileError('invalid', 'SSH profile file is invalid');
    }
    const validated = desktopSshProfilesResponseSchema.safeParse({ profiles: parsed });
    if (!validated.success) throw new DesktopSshProfileError('invalid', 'SSH profile file is invalid');
    const list = validated.data.profiles;
    if (list.length > MAX_DESKTOP_SSH_PROFILES) throw new DesktopSshProfileError('invalid', 'Too many SSH profiles');
    const ids = new Set<string>();
    for (const profile of list) {
      if (ids.has(profile.id)) throw new DesktopSshProfileError('invalid', 'Duplicate SSH profile IDs');
      ids.add(profile.id);
    }
    return list;
  }

  async list(): Promise<DesktopSshProfile[]> {
    return this.serialize(() => this.readUnlocked());
  }

  async save(profile: DesktopSshProfile): Promise<DesktopSshProfile[]> {
    const validated = desktopSshProfileSchema.parse(profile);
    return this.serialize(async () => {
      const profiles = await this.readUnlocked();
      const index = profiles.findIndex((entry) => entry.id === validated.id);
      if (index >= 0) profiles[index] = validated;
      else {
        if (profiles.length >= MAX_DESKTOP_SSH_PROFILES) throw new DesktopSshProfileError('too_many', 'Too many SSH profiles');
        profiles.push(validated);
      }
      await this.writeUnlocked(profiles);
      return profiles;
    });
  }

  async remove(id: string): Promise<DesktopSshProfile[]> {
    return this.serialize(async () => {
      const profiles = await this.readUnlocked();
      const kept = profiles.filter((profile) => profile.id !== id);
      await this.writeUnlocked(kept);
      return kept;
    });
  }

  private async writeUnlocked(profiles: DesktopSshProfile[]): Promise<void> {
    desktopSshProfilesResponseSchema.parse({ profiles });
    try {
      await writePrivateFile(this.options.filePath, JSON.stringify(profiles));
    } catch (error) {
      throw new DesktopSshProfileError('unavailable', `Cannot save SSH profiles: ${(error as Error).message}`);
    }
  }
}

export function defaultDesktopSshProfilePath(mainHomeDir: string): string {
  return join(mainHomeDir, 'remote-connections.json');
}
