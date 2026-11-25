import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import {
  spaceRecordSchema,
  type DesktopLocalSpaceSummary,
  type DesktopSpaceStatus,
} from '@kiki/protocol';
import { listLiveServerInstances, type ServerInstanceInfo } from '../../instanceRegistry';

export interface LocalSpacesServiceOptions {
  readonly mainHomeDir: string;
  readonly currentSpaceId: string;
  readonly desktopManaged?: boolean;
  readonly now?: () => number;
  readonly listInstances?: (homeDir?: string) => Promise<readonly ServerInstanceInfo[]>;
  readonly readBusySessions?: (homeDir: string) => Promise<{ busy: number; needsYou: number } | undefined>;
}

const homesFileSchema = z.array(spaceRecordSchema);

export class LocalSpacesService {
  private readonly now: () => number;
  constructor(private readonly options: LocalSpacesServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<{ spaces: DesktopLocalSpaceSummary[]; statuses: DesktopSpaceStatus[] }> {
    const records = await readHomesFile(this.options.mainHomeDir);
    const summaries: DesktopLocalSpaceSummary[] = [];
    const statuses: DesktopSpaceStatus[] = [];
    const mainInstances = await this.instancesFor(this.options.mainHomeDir);
    const mainLive = newest(mainInstances);
    summaries.push(this.summarize({
      homeId: 'main',
      name: 'Main space',
      path: this.options.mainHomeDir,
      isPrimary: true,
      registered: true,
      instance: mainLive,
    }));
    statuses.push(await this.statusFor('main', this.options.mainHomeDir, mainLive));
    for (const record of records) {
      const spaceHome = readSpaceHome(record.path).space;
      const home = spaceHome?.id === record.id ? spaceHome : undefined;
      const instances = await this.instancesFor(record.path);
      const live = newest(instances);
      summaries.push(this.summarize({
        homeId: record.id,
        name: home?.name ?? record.name,
        path: record.path,
        color: home?.color ?? record.color,
        preset: home?.preset ?? record.preset,
        isPrimary: false,
        registered: true,
        instance: live,
      }));
      statuses.push(await this.statusFor(record.id, record.path, live));
    }
    return { spaces: summaries, statuses };
  }

  private summarize(input: {
    homeId: string; name: string; path: string; color?: string; preset?: string;
    isPrimary: boolean; registered: boolean; instance?: ServerInstanceInfo;
  }): DesktopLocalSpaceSummary {
    return {
      home_id: input.homeId,
      name: input.name,
      path: input.path,
      color: input.color,
      preset: input.preset,
      is_primary: input.isPrimary,
      registered: input.registered,
      running: input.instance !== undefined,
      pid: input.instance?.pid,
      port: input.instance?.port,
      desktop_managed: input.homeId === this.options.currentSpaceId ? this.options.desktopManaged : undefined,
    };
  }

  private async statusFor(homeId: string, homeDir: string, instance?: ServerInstanceInfo): Promise<DesktopSpaceStatus> {
    const busy = this.options.readBusySessions !== undefined && instance !== undefined
      ? await this.options.readBusySessions(homeDir).catch(() => undefined)
      : undefined;
    const isCurrent = homeId === this.options.currentSpaceId;
    const state: DesktopSpaceStatus['state'] = instance === undefined
      ? 'offline'
      : isCurrent
        ? 'active'
        : (busy?.needsYou ?? 0) > 0
          ? 'pending'
          : (busy?.busy ?? 0) > 0
            ? 'busy'
            : 'hot';
    return {
      home_id: homeId,
      state,
      busy_sessions: busy?.busy ?? 0,
      needs_you_sessions: busy?.needsYou ?? 0,
      heartbeat_fresh: instance !== undefined,
      server_id: instance?.serverId,
      as_of: this.now(),
    };
  }

  private async instancesFor(homeDir: string): Promise<readonly ServerInstanceInfo[]> {
    if (this.options.listInstances !== undefined) return this.options.listInstances(homeDir);
    return listLiveServerInstances(homeDir);
  }
}

async function readHomesFile(mainHomeDir: string): Promise<z.infer<typeof spaceRecordSchema>[]> {
  let text: string;
  try {
    text = await readFile(join(mainHomeDir, 'homes.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return homesFileSchema.parse(JSON.parse(text));
}

function newest(instances: readonly ServerInstanceInfo[]): ServerInstanceInfo | undefined {
  let best: ServerInstanceInfo | undefined;
  for (const instance of instances) {
    if (best === undefined || instance.heartbeatAt > best.heartbeatAt ||
      (instance.heartbeatAt === best.heartbeatAt && instance.startedAt > best.startedAt)) {
      best = instance;
    }
  }
  return best;
}
