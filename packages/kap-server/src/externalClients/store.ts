import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { IAtomicDocumentStore, IBootstrapService, type Scope } from '@kiki/agent-core-v2';
import { connectionSchema, sessionSchema, ExternalClientError, type ExternalClientConnection, type ExternalClientSession, type ExternalClientOperation } from './contracts';

export class ExternalClientStore {
  readonly documents: IAtomicDocumentStore;
  readonly scope: string;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(readonly core: Scope) {
    this.documents = core.accessor.get(IAtomicDocumentStore);
    this.scope = core.accessor.get(IBootstrapService).scope('credentials');
  }
  serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(work, work);
    this.mutation = result.catch(() => undefined);
    return result;
  }
  async connections(): Promise<ExternalClientConnection[]> {
    const scope = `${this.scope}/external-clients/connections`;
    const keys = await this.documents.list(scope);
    return (await Promise.all(keys.map(key => this.documents.get(scope, key))))
      .flatMap(value => { const parsed = connectionSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  }
  async connection(id: string): Promise<ExternalClientConnection> {
    const parsed = connectionSchema.safeParse(await this.documents.get(this.scope, `external-clients/connections/${safeId(id)}`));
    if (!parsed.success) throw new ExternalClientError('connection_unavailable', 'External connection is unavailable.');
    return parsed.data;
  }
  async active(id: string): Promise<ExternalClientConnection> {
    const connection = await this.connection(id);
    if (connection.status !== 'active') throw new ExternalClientError('connection_unavailable', 'External connection is paused or revoked.');
    return connection;
  }
  saveConnection(connection: ExternalClientConnection): Promise<void> {
    return this.documents.set(this.scope, `external-clients/connections/${safeId(connection.id)}`, connection);
  }
  async credential(id: string): Promise<string> {
    await this.active(id);
    const token = `kec_${randomBytes(32).toString('base64url')}`;
    await this.documents.set(this.scope, `external-clients/tokens/${digest(token)}`, { connectionId: id, expiresAt: Date.now() + 3600_000 });
    return token;
  }
  async resolveBearer(token: string): Promise<ExternalClientConnection | undefined> {
    if (!token.startsWith('kec_')) return undefined;
    const entry = await this.documents.get<{connectionId: string; expiresAt: number}>(this.scope, `external-clients/tokens/${digest(token)}`);
    if (entry === undefined || entry.expiresAt <= Date.now()) return undefined;
    return this.active(entry.connectionId).catch(() => undefined);
  }
  async sessions(connectionId: string): Promise<ExternalClientSession[]> {
    const scope = `${this.scope}/external-clients/sessions/${safeId(connectionId)}`;
    const keys = await this.documents.list(scope);
    return (await Promise.all(keys.map(key => this.documents.get(scope, key))))
      .flatMap(value => { const parsed = sessionSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
  }
  saveSession(session: ExternalClientSession): Promise<void> {
    return this.documents.set(this.scope, `external-clients/sessions/${safeId(session.connectionId)}/${safeId(session.sessionRef)}`, session);
  }
  async touchSession(session: ExternalClientSession): Promise<void> {
    await this.documents.update<ExternalClientSession>(this.scope, `external-clients/sessions/${safeId(session.connectionId)}/${safeId(session.sessionRef)}`,
      current=>current===undefined?undefined:{...current,updatedAt:Date.now()});
  }
  async session(connectionId: string, ref: string): Promise<ExternalClientSession> {
    const parsed = sessionSchema.safeParse(await this.documents.get(this.scope, `external-clients/sessions/${safeId(connectionId)}/${safeId(ref)}`));
    if (!parsed.success) throw new ExternalClientError('session_unavailable', 'Session is not shared with this connection.');
    return parsed.data;
  }
  async sessionById(sessionId: string): Promise<ExternalClientSession | undefined> {
    for (const connection of await this.connections()) {
      const found = (await this.sessions(connection.id)).find(session => session.sessionId === sessionId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  async operation(id: string): Promise<ExternalClientOperation | undefined> {
    return this.documents.get(this.scope, `external-clients/operations/${safeId(id)}`);
  }
  saveOperation(operation: ExternalClientOperation): Promise<void> {
    return this.documents.set(this.scope, `external-clients/operations/${safeId(operation.id)}`, operation);
  }
  async admit(connectionId: string, sessionRef: string, name: string, args: Record<string, unknown>, key?: string): Promise<{operation: ExternalClientOperation; duplicate: boolean}> {
    return this.serialize(async () => {
      const hash = digest(canonical({name,args}));
      const id = key === undefined ? `op_${randomUUID()}` : `op_${digest(canonical({connectionId,sessionRef,key}))}`;
      const prior = await this.operation(id);
      if (prior !== undefined) {
        if (prior.hash !== hash) throw new ExternalClientError('idempotency_conflict', 'This idempotency key was accepted with different arguments.');
        return {operation: prior, duplicate: true};
      }
      const now = Date.now();
      const operation: ExternalClientOperation = {id,connectionId,sessionRef,name,arguments: args,hash,idempotencyKey:key,acceptedAt:now,updatedAt:now,state:'accepted'};
      await this.saveOperation(operation);
      return {operation,duplicate:false};
    });
  }
  async recover(): Promise<void> {
    const scope = `${this.scope}/external-clients/operations`;
    for (const key of await this.documents.list(scope)) {
      const op = await this.documents.get<ExternalClientOperation>(scope,key);
      if (op !== undefined && ['accepted','running','waiting_approval'].includes(op.state))
        await this.saveOperation({...op,state:'outcome_unknown',updatedAt:Date.now(),error:'Host stopped before committing an outcome; inspect the target before an explicit recovery.'});
    }
  }
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).toSorted(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new ExternalClientError('invalid_reference','Invalid external reference.');
  return id;
}
