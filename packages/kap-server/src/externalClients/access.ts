import { resolve, relative, isAbsolute } from 'node:path';
import { ISessionIndex, type Scope } from '@kiki/agent-core-v2';
import { IMemoryStore } from '@kiki/agent-core-v2/app/memory/memoryStore';
import type { MemoryScope } from '@kiki/agent-core-v2/app/memory/memoryScopes';
import { IHistoryArchive, type IHistoryArchive as HistoryArchive } from '@kiki/agent-core-v2/agent/tools/history/historyTools';
import { IHistoryDirectory, type IHistoryDirectory as HistoryDirectory } from '@kiki/agent-core-v2/agent/tools/history/historyListTool';
import { ExternalClientError, type ExternalClientSession } from './contracts';
import type { ExternalClientStore } from './store';

export function within(root: string, target: string): boolean {
  const path = relative(resolve(root),resolve(target));
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..\\`) && !path.startsWith('../'));
}
export class ExternalClientAccess {
  constructor(private readonly store: ExternalClientStore, readonly session: ExternalClientSession) {}
  async history(workspaceId: string | undefined, sessionId: string | undefined): Promise<void> {
    const grant = await this.store.active(this.session.connectionId);
    if (workspaceId !== undefined && workspaceId !== this.session.workspaceId)
      throw new ExternalClientError('history_unavailable', 'History is not shared with this connection.');
    if (sessionId === this.session.sessionId) return;
    if (sessionId !== undefined) {
      const target=await this.store.core.accessor.get(ISessionIndex).get(sessionId);
      if(target?.workspaceId!==this.session.workspaceId)throw new ExternalClientError('history_unavailable','History is outside the shared workspace.');
    }
    if (grant.historyScope === 'workspace') return;
    if (sessionId !== undefined && grant.historyScope === 'connection' &&
      (await this.store.sessions(grant.id)).some(s=>s.sessionId===sessionId && s.workspace===this.session.workspace)) return;
    throw new ExternalClientError('history_unavailable', 'History is not shared with this connection. Use an explicitly shared session.');
  }
  async ref(ref: string): Promise<void> {
    let target: {workspace?: string; session?: string};
    try { target = JSON.parse(Buffer.from(ref.replace(/^h1_/,''),'base64url').toString('utf8')); }
    catch { throw new ExternalClientError('history_unavailable','History reference is unavailable.'); }
    if (typeof target.session !== 'string' || typeof target.workspace !== 'string')
      throw new ExternalClientError('history_unavailable','History reference is unavailable.');
    await this.history(target.workspace,target.session);
  }
  async memory(scope: MemoryScope): Promise<boolean> {
    const grant = await this.store.active(this.session.connectionId);
    return grant.memoryScopes.includes(scope.kind) &&
      (!('workspaceId' in scope) || scope.workspaceId === this.session.workspaceId) &&
      (!('personaId' in scope));
  }
  async scopes(scopes: readonly MemoryScope[]): Promise<MemoryScope[]> {
    const allowed = await Promise.all(scopes.map(async scope => await this.memory(scope) ? scope : undefined));
    return allowed.filter((scope): scope is MemoryScope=>scope!==undefined);
  }
  async assertMemory(scope: MemoryScope): Promise<void> {
    if (!await this.memory(scope)) throw new ExternalClientError('memory_unavailable','Memory scope is not shared with this connection.');
  }
  wrapArchive(archive: HistoryArchive): HistoryArchive {
    return { _serviceBrand: undefined,
      search: async query => { await this.history(query.workspaceId,query.sessionId); if(query.peer) throw new ExternalClientError('history_unavailable','Peer communication is not shared.'); return archive.search(query); },
      readTurn: async (session,agent,turn,step)=>{await this.history(undefined,session);return archive.readTurn(session,agent,turn,step);},
      readRef: archive.readRef === undefined ? undefined : async ref=>{await this.ref(ref);return archive.readRef!(ref);},
      lookupDirectory: archive.lookupDirectory === undefined ? undefined : async (workspace,session,agent,turn,step,preparation,signal)=>{await this.history(workspace,session);return archive.lookupDirectory!(workspace,session,agent,turn,step,preparation,signal);},
      directoryRef: archive.directoryRef === undefined ? undefined : async (workspace,session,agent,turn,step)=>{await this.history(workspace,session);return archive.directoryRef!(workspace,session,agent,turn,step);},
      readDirectory: archive.readDirectory === undefined ? undefined : async (ref,max,cursor)=>{await this.ref(ref);return archive.readDirectory!(ref,max,cursor);},
    };
  }
  wrapDirectory(directory: HistoryDirectory): HistoryDirectory {
    return {_serviceBrand:undefined,list:async request=>{await this.history(request.workspaceId,request.sessionId);return directory.list(request);}};
  }
  wrapMemory(store: IMemoryStore): IMemoryStore {
    return { _serviceBrand: undefined, onDidChange: store.onDidChange,
      get: async (scope,id)=> await this.memory(scope) ? store.get(scope,id) : undefined,
      list: async (scope,inactive)=> await this.memory(scope) ? store.list(scope,inactive) : [],
      inventory: async scope=>{await this.assertMemory(scope);return store.inventory(scope);},
      query: async (scopes,input)=>store.query(await this.scopes(scopes),input),
      search: async (scopes,query,type,inactive)=>store.search(await this.scopes(scopes),query,type,inactive),
      put: async input=>{await this.assertMemory(input.scope);return store.put({...input,basis:input.basis?.kind==='human'?{...input.basis,kind:'derived'}:input.basis});},
      delete: async(scope,id,revision,writer)=>{await this.assertMemory(scope);return store.delete(scope,id,revision,writer);},
      journal: async(scope,id)=>{await this.assertMemory(scope);return store.journal(scope,id);},
      undo: async(scope,id)=>{await this.assertMemory(scope);return store.undo(scope,id);},
      listPersonaEntries: async()=>[],
      deletePersonaNamespaces: async()=>{throw new ExternalClientError('memory_unavailable','Persona administration is not shared.');},
      importLorebook: async(scope,entries,source)=>{await this.assertMemory(scope);return store.importLorebook(scope,entries,source);},
    };
  }
}
export function externalClientSeeds(core: Scope, access: ExternalClientAccess) {
  return [
    {id:IHistoryArchive,value:access.wrapArchive(core.accessor.get(IHistoryArchive))},
    {id:IHistoryDirectory,value:access.wrapDirectory(core.accessor.get(IHistoryDirectory))},
    {id:IMemoryStore,value:access.wrapMemory(core.accessor.get(IMemoryStore))},
  ] as const;
}
