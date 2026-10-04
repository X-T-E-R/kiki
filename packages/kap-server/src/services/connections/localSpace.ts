import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { IBootstrapService, type Scope } from '@kiki/agent-core-v2';
import { readSpaceHome } from '@kiki/agent-core-v2/app/bootstrap/spaceHome';
import { spaceRecordSchema, connectionHandshakeSchema, type ConnectionIdentity } from '@kiki/protocol';
import { readBoundedJsonBody } from '@kiki/klient/transports/http/bounded-body';
import { listLiveServerInstances } from '../../instanceRegistry';
import { readLocalOwnerToken } from '../auth/localOwner';
import { readPrivateFile } from '../auth/privateFiles';
import { AdmissionError, sameIdentity } from './admission';

export async function resolveRegisteredLocalSpace(core: Scope, localSpaceId: string): Promise<{ id: string; name: string; path: string }> {
  const bootstrap = core.accessor.get(IBootstrapService);
  const main = bootstrap.baseHomeDir ?? bootstrap.homeDir;
  const records = localSpaceId === 'main' ? [] : z.array(spaceRecordSchema).parse(JSON.parse(await readFile(join(main, 'homes.json'), 'utf8')));
  const record = localSpaceId === 'main' ? { id: 'main', path: main, name: 'Main space' } : records.find((entry) => entry.id === localSpaceId);
  if (record === undefined) throw new AdmissionError(404, 'registered_space_not_found');
  const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (normalized(record.path) === normalized(bootstrap.homeDir)) throw new AdmissionError(400, 'same_home_requires_no_bridge');
  if (record.id !== 'main' && readSpaceHome(record.path).space?.id !== record.id) throw new AdmissionError(409, 'registered_space_identity_changed');
  return { id: record.id, name: record.name, path: record.path };
}
export async function resolveLocalSpaceTransport(core: Scope, localSpaceId: string, target: ConnectionIdentity, signal: AbortSignal): Promise<{ endpoint: string; target: ConnectionIdentity }> {
  signal.throwIfAborted();
  const record = await resolveRegisteredLocalSpace(core, localSpaceId);
  let homeId: string;
  try { homeId = (await readPrivateFile(join(record.path, 'server', 'home-id'))).toString('utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AdmissionError(503, 'target_daemon_unavailable_start_registered_space'); throw error; }
  if (homeId !== target.homeId) throw new AdmissionError(409, 'identity_changed');
  const instances = (await listLiveServerInstances(record.path)).filter((entry) => ['127.0.0.1', 'localhost', '::1'].includes(entry.host));
  if (instances.length !== 1) throw new AdmissionError(503, 'target_daemon_unavailable_start_registered_space');
  const token = await readLocalOwnerToken(record.path);
  if (token === undefined) throw new AdmissionError(503, 'target_local_owner_unavailable');
  const host = instances[0]!.host === '::1' ? '[::1]' : '127.0.0.1';
  const endpoint = `http://${host}:${instances[0]!.port}`;
  const response = await fetch(endpoint + '/api/remote-connections/handshake', { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
  const envelope = await readBoundedJsonBody(response, 8192) as { code: number; data: unknown };
  if (!response.ok || envelope.code !== 0) throw new AdmissionError(503, 'target_daemon_unavailable_start_registered_space');
  const handshake = connectionHandshakeSchema.parse(envelope.data);
  if (!sameIdentity(handshake.identity, target)) throw new AdmissionError(409, 'identity_changed');
  return { endpoint, target: { ...target } };
}
