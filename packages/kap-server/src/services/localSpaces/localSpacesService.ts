import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import {
  spaceRecordSchema,
  type DesktopLocalSpaceSummary,
  type DesktopSpaceStatus,
} from '@kiki/protocol';
import { listLiveServerInstances, type ServerInstanceInfo } from '../../instanceRegistry';
import { readLocalOwnerToken } from '../auth/localOwner';

const SIBLING_PROBE_TIMEOUT_MS = 2_500;
const MAX_SIBLING_SESSIONS_BYTES = 2 * 1024 * 1024;
const MAX_SIBLING_LIFECYCLE_BYTES = 64 * 1024;

export interface BusySessionsSnapshot {
  readonly busy: number;
  readonly needsYou: number;
  readonly needsYouSessionIds?: readonly string[];
  readonly desktopManaged?: boolean;
}

export interface LocalSpacesServiceOptions {
  readonly mainHomeDir: string;
  readonly currentSpaceId: string;
  readonly desktopManaged?: boolean;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly readToken?: (homeDir: string) => Promise<string | undefined>;
  readonly listInstances?: (homeDir?: string) => Promise<readonly ServerInstanceInfo[]>;
  readonly readBusySessions?: (homeDir: string) => Promise<BusySessionsSnapshot | undefined>;
}

const homesFileSchema = z.array(spaceRecordSchema);
const siblingLifecycleEnvelopeSchema = z.object({
  code: z.literal(0),
  data: z.object({ managed: z.boolean().optional() }),
});
const siblingSessionItemSchema = z.object({
  id: z.string().optional(),
  busy: z.boolean().optional(),
  pending_interaction: z.string().optional(),
});
const siblingSessionsEnvelopeSchema = z.object({
  code: z.literal(0),
  data: z.object({
    items: z.array(siblingSessionItemSchema),
    ephemeral: z.array(siblingSessionItemSchema).optional(),
  }),
});

export class LocalSpacesService {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: (homeDir: string) => Promise<string | undefined>;
  constructor(private readonly options: LocalSpacesServiceOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.readToken = options.readToken ?? readLocalOwnerToken;
  }

  async snapshot(): Promise<{ spaces: DesktopLocalSpaceSummary[]; statuses: DesktopSpaceStatus[] }> {
    const records = await readHomesFile(this.options.mainHomeDir);
    const summaries: DesktopLocalSpaceSummary[] = [];
    const statuses: DesktopSpaceStatus[] = [];
    const mainInstances = await this.instancesFor(this.options.mainHomeDir);
    const mainLive = newest(mainInstances);
    const mainObserved = await this.observeSpace('main', this.options.mainHomeDir, mainLive);
    summaries.push(this.summarize({
      homeId: 'main',
      name: 'Main space',
      path: this.options.mainHomeDir,
      isPrimary: true,
      registered: true,
      instance: mainLive,
      desktopManaged: mainObserved?.desktopManaged,
    }));
    statuses.push(this.statusFor('main', mainLive, mainObserved));
    for (const record of records) {
      const spaceHome = readSpaceHome(record.path).space;
      const home = spaceHome?.id === record.id ? spaceHome : undefined;
      const instances = await this.instancesFor(record.path);
      const live = newest(instances);
      const observed = await this.observeSpace(record.id, record.path, live);
      summaries.push(this.summarize({
        homeId: record.id,
        name: home?.name ?? record.name,
        path: record.path,
        color: home?.color ?? record.color,
        preset: home?.preset ?? record.preset,
        isPrimary: false,
        registered: true,
        instance: live,
        desktopManaged: observed?.desktopManaged,
      }));
      statuses.push(this.statusFor(record.id, live, observed));
    }
    return { spaces: summaries, statuses };
  }

  private summarize(input: {
    homeId: string; name: string; path: string; color?: string; preset?: string;
    isPrimary: boolean; registered: boolean; instance?: ServerInstanceInfo; desktopManaged?: boolean;
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
      desktop_managed: input.homeId === this.options.currentSpaceId ? this.options.desktopManaged : input.desktopManaged,
    };
  }

  private async observeSpace(
    homeId: string,
    homeDir: string,
    instance?: ServerInstanceInfo,
  ): Promise<BusySessionsSnapshot | undefined> {
    if (instance === undefined) return undefined;
    const direct = this.options.readBusySessions !== undefined
      ? await this.options.readBusySessions(homeDir).catch(() => undefined)
      : undefined;
    if (direct !== undefined) return direct;
    if (homeId === this.options.currentSpaceId) return undefined;
    return this.probeSiblingInstance(homeDir, instance.port).catch(() => undefined);
  }

  private async probeSiblingInstance(homeDir: string, port: number): Promise<BusySessionsSnapshot | undefined> {
    const token = await this.readToken(homeDir).catch(() => undefined);
    if (token === undefined || token === '') return undefined;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const base = `http://127.0.0.1:${port}`;
    const [lifecycleRes, sessionsRes] = await Promise.allSettled([
      (async () => {
        const signal = AbortSignal.timeout(SIBLING_PROBE_TIMEOUT_MS);
        const res = await this.fetchImpl(new URL('/api/desktop-lifecycle', base), { headers, redirect: 'error', signal });
        if (res.status !== 200) {
          void res.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const parsed = siblingLifecycleEnvelopeSchema.safeParse(
          await readBoundedJsonBody(res, MAX_SIBLING_LIFECYCLE_BYTES, signal),
        );
        return parsed.success ? parsed.data.data.managed : undefined;
      })(),
      (async () => {
        const signal = AbortSignal.timeout(SIBLING_PROBE_TIMEOUT_MS);
        const res = await this.fetchImpl(new URL('/api/sessions?include_ephemeral=true', base), { headers, redirect: 'error', signal });
        if (res.status !== 200) {
          void res.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const parsed = siblingSessionsEnvelopeSchema.safeParse(
          await readBoundedJsonBody(res, MAX_SIBLING_SESSIONS_BYTES, signal),
        );
        if (!parsed.success) return undefined;
        const seenNeedsYou = new Set<string>();
        let needsYou = 0;
        let busy = 0;
        for (const item of [...parsed.data.data.items, ...(parsed.data.data.ephemeral ?? [])]) {
          const pending = item.pending_interaction === 'approval' || item.pending_interaction === 'question';
          if (pending) {
            needsYou += 1;
            if (item.id !== undefined && item.id !== '') seenNeedsYou.add(item.id);
          } else if (item.busy === true) {
            busy += 1;
          }
        }
        return { busy, needsYou, needsYouSessionIds: [...seenNeedsYou] };
      })(),
    ]);
    const desktopManaged = lifecycleRes.status === 'fulfilled' ? lifecycleRes.value : undefined;
    const counts = sessionsRes.status === 'fulfilled' ? sessionsRes.value : undefined;
    if (desktopManaged === undefined && counts === undefined) return undefined;
    return {
      busy: counts?.busy ?? 0,
      needsYou: counts?.needsYou ?? 0,
      needsYouSessionIds: counts?.needsYouSessionIds,
      desktopManaged,
    };
  }

  private statusFor(homeId: string, instance?: ServerInstanceInfo, busy?: BusySessionsSnapshot): DesktopSpaceStatus {
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
      ...(busy?.needsYouSessionIds !== undefined && busy.needsYouSessionIds.length > 0
        ? { needs_you_session_ids: [...busy.needsYouSessionIds] }
        : {}),
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
