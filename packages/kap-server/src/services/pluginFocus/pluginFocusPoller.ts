import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { pluginNavigationSchema, spaceRecordSchema } from '@kiki/protocol';
import { listLiveServerInstances, type ServerInstanceInfo } from '../../instanceRegistry';
import { readLocalOwnerToken } from '../auth/localOwner';
import type { PluginFocusRequest, PluginFocusService } from './pluginFocusService';
import { pluginFocusIsActionable } from './pluginFocusService';

export const PLUGIN_FOCUS_POLL_INTERVAL_MS = 2_000;
const PLUGIN_FOCUS_PROBE_TIMEOUT_MS = 3_000;
const MAX_NAVIGATION_BYTES = 64 * 1024;

const navigationEnvelopeSchema = z.object({ code: z.literal(0), data: pluginNavigationSchema });

export interface PluginFocusPollerOptions {
  readonly focus: PluginFocusService;
  readonly mainHomeDir: string;
  readonly currentSpaceId: string;
  readonly serverToken?: () => string;
  readonly readToken?: (homeDir: string) => Promise<string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly listInstances?: (homeDir: string) => Promise<readonly ServerInstanceInfo[]>;
}

export class PluginFocusPoller {
  private readonly fetchImpl: typeof fetch;
  private readonly readToken: (homeDir: string) => Promise<string | undefined>;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private activePoll: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly options: PluginFocusPollerOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.readToken = options.readToken ?? readLocalOwnerToken;
    this.intervalMs = options.intervalMs ?? PLUGIN_FOCUS_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.timer = setInterval(() => { void this.pollOnce().catch(() => undefined); }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.activePoll;
  }

  async pollOnce(): Promise<void> {
    if (this.activePoll !== undefined || this.stopped) return;
    const work = this.pollInner();
    this.activePoll = work;
    try {
      await work;
    } finally {
      if (this.activePoll === work) this.activePoll = undefined;
    }
  }

  private async pollInner(): Promise<void> {
    const targets = await this.siblingTargets();
    const nowMs = this.now();
    const candidates: { homeId: string; request: PluginFocusRequest }[] = [];
    await Promise.all(targets.map(async (target) => {
      const request = await this.probe(target).catch(() => undefined);
      if (request === undefined) return;
      if (!pluginFocusIsActionable(request, this.options.focus.seenRequestId(target.homeId), nowMs)) return;
      candidates.push({ homeId: target.homeId, request });
    }));
    if (candidates.length === 0) return;
    candidates.sort((left, right) => right.request.at - left.request.at || right.request.id - left.request.id);
    const selected = candidates[0]!;
    const intent = this.options.focus.publish(selected.homeId, selected.request);
    if (intent === undefined) this.options.focus.remember(selected.homeId, selected.request.id);
  }

  private async probe(target: { homeId: string; homeDir: string; port: number }): Promise<PluginFocusRequest | undefined> {
    const token = (await this.readToken(target.homeDir).catch(() => undefined)) ?? this.options.serverToken?.();
    if (token === undefined || token === '') return undefined;
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(PLUGIN_FOCUS_PROBE_TIMEOUT_MS)]);
    const response = await this.fetchImpl(new URL('/api/plugins/navigation', `http://127.0.0.1:${target.port}`), {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const parsed = navigationEnvelopeSchema.safeParse(await readBoundedJsonBody(response, MAX_NAVIGATION_BYTES, signal));
    if (!parsed.success || parsed.data.data.request === undefined) return undefined;
    return parsed.data.data.request;
  }

  private async siblingTargets(): Promise<{ homeId: string; homeDir: string; port: number }[]> {
    const homes: { homeId: string; homeDir: string }[] = [{ homeId: 'main', homeDir: this.options.mainHomeDir }];
    for (const record of await readHomesFile(this.options.mainHomeDir)) {
      homes.push({ homeId: record.id, homeDir: record.path });
    }
    const targets: { homeId: string; homeDir: string; port: number }[] = [];
    for (const home of homes) {
      if (home.homeId === this.options.currentSpaceId) continue;
      const listInstances = this.options.listInstances ?? listLiveServerInstances;
      const instances = await listInstances(home.homeDir).catch(() => []);
      let newest: { port: number; heartbeatAt: number } | undefined;
      for (const instance of instances) {
        if (newest === undefined || instance.heartbeatAt > newest.heartbeatAt) newest = instance;
      }
      if (newest !== undefined) targets.push({ homeId: home.homeId, homeDir: home.homeDir, port: newest.port });
    }
    return targets;
  }
}

async function readHomesFile(mainHomeDir: string): Promise<z.infer<typeof spaceRecordSchema>[]> {
  try {
    const raw = JSON.parse(await readFile(join(mainHomeDir, 'homes.json'), 'utf8'));
    return z.array(spaceRecordSchema).parse(raw);
  } catch {
    return [];
  }
}
