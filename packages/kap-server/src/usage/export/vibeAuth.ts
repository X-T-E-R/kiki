import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { planHttpConnection } from '@nb-im/core';
import { z } from 'zod';
import { VIBE_CAFE_ORIGIN, VIBE_CAFE_INGEST_ENDPOINT, usageExportVibeAuthInputSchema, usageExportVibeAuthSchema, type UsageExportDestination, type UsageExportSave, type UsageExportVibeAuth, type UsageExportVibeAuthInput } from '@kiki/protocol';

export type VibeAuthRequest = (path: '/api/usage/device/code' | '/api/usage/device/poll', body: Record<string, string>, signal: AbortSignal) => Promise<unknown>;
const deviceSchema = z.object({ deviceCode: z.string().min(1).max(2048), userCode: z.string().min(1).max(128), verificationUriComplete: z.string().url(), expiresIn: z.number().int().min(1).max(1800).optional(), interval: z.number().int().min(1).max(60).optional() });
const pollSchema = z.object({ apiKey: z.string().regex(/^vbu_[A-Za-z0-9._~+/-]{1,1000}$/).optional(), apiUrl: z.string().url().optional(), error: z.string().max(128).optional() });
interface Flow {
  snapshot: UsageExportVibeAuth;
  deviceCode: string;
  original: string;
  input: UsageExportVibeAuthInput;
  controller: AbortController;
  interval: number;
  nextPoll: number;
  flight?: Promise<UsageExportVibeAuth>;
  committing: boolean;
}
export class VibeCafeDeviceAuth {
  private readonly flows = new Map<string, Flow>();
  private closed = false;
  constructor(private readonly get: (id: string) => UsageExportDestination, private readonly save: (input: UsageExportSave) => Promise<UsageExportDestination>, private readonly send: VibeAuthRequest = requestVibeAuth, private readonly now: () => number = Date.now) {}
  async begin(id: string, input: UsageExportVibeAuthInput): Promise<UsageExportVibeAuth> {
    if (this.closed) throw new Error('vibe-auth-unavailable');
    const parsed = usageExportVibeAuthInputSchema.parse(input);
    if (parsed.storage === 'private-file' && !parsed.acknowledge_file_storage) throw new Error('private-file-storage-requires-consent');
    const destination = this.get(id);
    if (destination.target.kind !== 'vibe' || destination.target.endpoint !== VIBE_CAFE_INGEST_ENDPOINT || destination.target.private_grant !== undefined) throw new Error('vibe-auth-official-only');
    if (destination.enabled) throw new Error('vibe-auth-disable-first');
    for (const [key, flow] of this.flows) {
      if (flow.snapshot.state !== 'pending' || flow.snapshot.expires_at <= this.now()) { flow.controller.abort(); this.flows.delete(key); }
      else if (flow.snapshot.destination_id === id) await this.cancel(key);
    }
    if (this.flows.size >= 32) throw new Error('vibe-auth-unavailable');
    const controller = new AbortController();
    const flowId = randomUUID();
    const flow: Flow = { snapshot: { flow_id: flowId, destination_id: id, state: 'pending', user_code: '', verification_uri: `${VIBE_CAFE_ORIGIN}/usage/device`, expires_at: this.now() + 900_000, poll_after_ms: 5000, error_category: null }, original: JSON.stringify(destination), deviceCode: '', input: parsed, controller, interval: 5000, nextPoll: this.now() + 5000, committing: false };
    this.flows.set(flowId, flow);
    try {
      const device = deviceSchema.parse(await this.send('/api/usage/device/code', { clientName: 'Kiki', hostname: `kiki-${destination.stream_id}` }, controller.signal));
      const verification = new URL(device.verificationUriComplete);
      if (verification.origin !== VIBE_CAFE_ORIGIN || verification.pathname !== '/usage/device' || verification.username || verification.password || verification.hash) throw new Error('vibe-auth-invalid-response');
      if (controller.signal.aborted || this.closed) return this.finish(flow, 'cancelled');
      flow.deviceCode = device.deviceCode;
      flow.interval = (device.interval ?? 5) * 1000;
      flow.nextPoll = this.now() + flow.interval;
      flow.snapshot = { ...flow.snapshot, user_code: device.userCode, verification_uri: verification.href, expires_at: this.now() + (device.expiresIn ?? 900) * 1000, poll_after_ms: flow.interval };
    } catch { return this.finish(flow, controller.signal.aborted ? 'cancelled' : 'error', 'vibe-auth-start-failed'); }
    return this.view(flow);
  }
  async poll(flowId: string): Promise<UsageExportVibeAuth> {
    const flow = this.require(flowId);
    if (flow.snapshot.state !== 'pending') return this.view(flow);
    if (this.now() >= flow.snapshot.expires_at) return this.finish(flow, 'expired');
    if (flow.flight !== undefined) return flow.flight;
    if (this.now() < flow.nextPoll) return this.view(flow);
    const flight = this.exchange(flow); flow.flight = flight;
    try { return await flight; } finally { flow.flight = undefined; }
  }
  private async exchange(flow: Flow): Promise<UsageExportVibeAuth> {
    flow.nextPoll = this.now() + flow.interval;
    let value: unknown;
    try { value = await this.send('/api/usage/device/poll', { deviceCode: flow.deviceCode }, flow.controller.signal); }
    catch { if (flow.controller.signal.aborted) return this.view(flow); flow.snapshot.error_category = 'vibe-auth-network'; return this.view(flow); }
    if (flow.controller.signal.aborted || this.closed || flow.snapshot.state !== 'pending') return this.view(flow);
    if (this.now() >= flow.snapshot.expires_at) return this.finish(flow, 'expired');
    try {
      const result = pollSchema.parse(value);
      if (result.apiKey !== undefined) {
        if (result.error !== undefined || (result.apiUrl !== undefined && new URL(result.apiUrl).href !== `${VIBE_CAFE_ORIGIN}/`)) throw new Error('vibe-auth-invalid-response');
        const destination = this.get(flow.snapshot.destination_id);
        if (JSON.stringify(destination) !== flow.original) return this.finish(flow, 'error', 'vibe-auth-destination-changed');
        flow.committing = true;
        await this.save({ draft: { id: destination.id, label: destination.label, target: destination.target, scope: destination.scope, schedule_minutes: destination.schedule_minutes as UsageExportSave['draft']['schedule_minutes'] }, secret: { value: result.apiKey, ...flow.input } });
        return this.finish(flow, 'connected');
      }
      if (result.error === 'authorization_pending') { flow.snapshot.error_category = null; return this.view(flow); }
      if (result.error === 'slow_down') { flow.interval = Math.min(60_000, flow.interval + 5000); flow.nextPoll = this.now() + flow.interval; return this.view(flow); }
      if (result.error === 'access_denied') return this.finish(flow, 'denied');
      if (result.error === 'expired_token') return this.finish(flow, 'expired');
      return this.finish(flow, 'error', 'vibe-auth-invalid-response');
    } catch (error) {
      const category = error instanceof Error && ['keyring-unavailable', 'identity-change-requires-new-destination', 'private-file-storage-requires-consent'].includes(error.message) ? error.message : flow.committing ? 'vibe-auth-storage-failed' : 'vibe-auth-invalid-response';
      return this.finish(flow, 'error', category);
    } finally { flow.committing = false; }
  }
  async cancel(flowId: string): Promise<UsageExportVibeAuth> {
    const flow = this.require(flowId);
    if (flow.committing && flow.flight !== undefined) return flow.flight;
    if (flow.snapshot.state === 'pending') { flow.controller.abort(); this.finish(flow, 'cancelled'); }
    return this.view(flow);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const flow of this.flows.values()) if (!flow.committing) { flow.controller.abort(); this.finish(flow, 'cancelled'); }
    const flights = [...this.flows.values()]
      .map((flow) => flow.flight)
      .filter((flight): flight is Promise<UsageExportVibeAuth> => flight !== undefined);
    await Promise.allSettled(flights);
    this.flows.clear();
  }
  private require(id: string): Flow { const flow = this.flows.get(id); if (flow === undefined) throw new Error('vibe-auth-flow-not-found'); return flow; }
  private finish(flow: Flow, state: UsageExportVibeAuth['state'], category: string | null = null): UsageExportVibeAuth {
    flow.snapshot.state = state; flow.snapshot.error_category = category; flow.deviceCode = ''; return this.view(flow);
  }
  private view(flow: Flow): UsageExportVibeAuth { return usageExportVibeAuthSchema.parse({ ...flow.snapshot, poll_after_ms: flow.snapshot.state === 'pending' ? Math.max(0, flow.nextPoll - this.now()) : 0 }); }
}
export const requestVibeAuth: VibeAuthRequest = async (path, input, signal) => {
  const plan = await planHttpConnection({ url: `${VIBE_CAFE_ORIGIN}${path}`, body: '', content_type: 'application/json' });
  const body = Buffer.from(JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const req = request({ hostname: plan.url.hostname, path, port: plan.url.port, method: 'POST', agent: false, family: plan.family, signal, lookup: (_host, _options, callback) => callback(null, plan.ip, plan.family), headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) req.destroy(new Error('vibe-auth-invalid-response')); else chunks.push(chunk); });
      res.on('error', reject); res.on('aborted', () => reject(new Error('vibe-auth-network')));
      res.on('end', () => { try { if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) throw new Error('vibe-auth-network'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('vibe-auth-invalid-response')); } });
    });
    const timeout = setTimeout(() => req.destroy(new Error('vibe-auth-network')), 15000); timeout.unref();
    req.on('close', () => clearTimeout(timeout)); req.on('error', reject); req.end(body);
  });
};
