import { z } from 'zod';
import { localBridgePolicySchema } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { listLiveServerInstances } from '../../instanceRegistry';
import { readLocalOwnerToken } from '../auth/localOwner';
import { AdmissionError } from '../connections/admission';
import { resolveRegisteredLocalSpace, resolveLocalSpaceTransport } from '../connections/localSpace';
import type { SpaceThreadBridge } from './bridge';

export const localBridgeProvisionSchema = localBridgePolicySchema;
export async function provisionLocalBridge(bridge: SpaceThreadBridge, input: z.infer<typeof localBridgeProvisionSchema>) {
  const record = await resolveRegisteredLocalSpace(bridge.core, input.spaceId);
  const instances = (await listLiveServerInstances(record.path)).filter((entry) => ['127.0.0.1', 'localhost', '::1'].includes(entry.host));
  if (instances.length !== 1) throw new AdmissionError(503, 'target_daemon_unavailable_start_registered_space');
  const token = await readLocalOwnerToken(record.path);
  if (token === undefined) throw new AdmissionError(503, 'target_local_owner_unavailable');
  const host = instances[0]!.host === '::1' ? '[::1]' : '127.0.0.1';
  const endpoint = `http://${host}:${instances[0]!.port}`;
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const envelope = await readBoundedJsonBody(response, 32768) as { code: number; msg: string; data: T };
    if (!response.ok || envelope.code !== 0) throw new AdmissionError(response.status, envelope.msg); return envelope.data;
  };
  const target = await call<ReturnType<SpaceThreadBridge['status']>>('/api/thread-bridges');
  if (!target.inboundEnabled) throw new AdmissionError(403, 'target_inbound_disabled');
  await resolveLocalSpaceTransport(bridge.core, input.spaceId, target.identity, AbortSignal.timeout(15000));
  const { spaceId: _spaceId, ...policy } = input;
  const approved = await call<Awaited<ReturnType<SpaceThreadBridge['approve']>>>('/api/thread-bridges/inbound', { ...policy, location: 'local', source: bridge.admission.identity, target: target.identity });
  try {
    const descriptor = await bridge.connections.registerBridgeTarget({ label: record.name, endpoint: `space://${record.id}`, target: target.identity,
      transport: { kind: 'local_space', localSpaceId: record.id } });
    return await bridge.install({ connectionId: descriptor.id, ...approved });
  } catch (error) { await call(`/api/thread-bridges/inbound/${approved.grant.id}/revoke`, {}).catch(() => {}); throw error; }
}
