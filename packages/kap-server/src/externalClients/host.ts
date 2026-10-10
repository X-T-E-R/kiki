import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { IBootstrapService, ISessionManager, ISessionMetadata, IAgentLifecycleService,
  IAgentToolRegistryService, IAgentToolPolicyService, IAgentToolExecutorService, IAgentPermissionModeService,
  ISessionContext, ISessionInteractionService, ensureMainAgent, type Scope, type IAgentScopeHandle,
} from '@kiki/agent-core-v2';
import { IAgentTaskService } from '@kiki/agent-core-v2/agent/task/task';
import { ExternalClientRecorder } from '@kiki/agent-core-v2/agent/execution/externalClientRecorder';
import { withSessionOperation } from '../lib/sessionOperationLease';
import { ExternalClientStore } from './store';
import { operationReceipt as receipt } from './results';
import { IAgentScopeContext } from '@kiki/agent-core-v2/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '@kiki/agent-core-v2/agent/loop/loop';
import { ExternalClientAccess, externalClientSeeds, within } from './access';
import { connectionInputSchema, connectionPatchSchema, DEFAULT_EXTERNAL_TOOLS, READ_ONLY_EXTERNAL_TOOLS,
  saveTextSchema, bridgeInputSchema, ExternalClientError, type ExternalClientConnection, type ExternalClientSession, type ExternalClientOperation } from './contracts';
import type { ExternalClientCallMeta, ExternalClientGrant, ExternalClientToolDescriptor } from '../mcp/externalClientTransport/host';

interface Running { readonly controller: AbortController; readonly done: Promise<void> }
export class ExternalClientHost {
  readonly store: ExternalClientStore;
  private readonly sessionBindings = new Map<string,ExternalClientSession>();
  private readonly queues = new Map<string,Promise<unknown>>();
  private readonly running = new Map<string,Running>();
  private readonly disposables: {dispose():void}[] = [];
  private readonly catalogListeners = new Set<(grantId: string) => void>();
  constructor(readonly core: Scope) { this.store = new ExternalClientStore(core); }
  onCatalogChanged(listener: (grantId: string) => void): { dispose(): void } {
    this.catalogListeners.add(listener);
    return { dispose: () => { this.catalogListeners.delete(listener); } };
  }
  async initialize(): Promise<void> {
    await this.store.recover();
    for(const connection of await this.store.connections()) for(const session of await this.store.sessions(connection.id)) this.sessionBindings.set(session.sessionId,session);
    const manager = this.core.accessor.get(ISessionManager);
    if(manager.onWillCreateSession !== undefined) this.disposables.push(manager.onWillCreateSession(event=>{
      const pending=this.sessionBindings.get(event.sessionId);
      if(pending===undefined) return;
      const record={...pending,workspaceId:event.readSeed(ISessionContext).workspaceId};
      this.sessionBindings.set(event.sessionId,record);
      const access=new ExternalClientAccess(this.store,record);
      const [archive,directory,memory]=externalClientSeeds(this.core,access);
      event.contributeSeed(archive.id,archive.value);
      event.contributeSeed(directory.id,directory.value);
      event.contributeSeed(memory.id,memory.value);
    }));
    if(manager.onDidCreateSession !== undefined) this.disposables.push(manager.onDidCreateSession(event=>{
      const record=this.sessionBindings.get(event.sessionId);
      if(record===undefined) return;
      event.waitUntil(this.attachSession(event.handle,record));
    }));
  }
  private async attachSession(session: Awaited<ReturnType<ISessionManager['create']>>, record: ExternalClientSession): Promise<void> {
    const lifecycle=session.accessor.get(IAgentLifecycleService);
    this.disposables.push(lifecycle.onWillCreate(agent=>{this.attachAgent(agent,record);}));
    for(const agent of lifecycle.list()) this.attachAgent(agent,record);
    const metadata=session.accessor.get(ISessionMetadata);
    await metadata.ready;
    const current=await metadata.read();
    await metadata.update({custom:{...current.custom,externalClient:{driver:'external',connectionId:record.connectionId,clientName:record.clientName,sessionRef:record.sessionRef}}});
    await this.store.saveSession(record);
    await this.refreshCatalog(await this.store.connection(record.connectionId), session);
  }
  async prepareOwnerSession(connectionId: string, sessionId: string, workspace: string,
    permissionMode?: ExternalClientConnection['mode'], profile?: string, profileFile?: string): Promise<void> {
    const connection = await this.store.active(connectionId);
    const now = Date.now();
    const record: ExternalClientSession = {
      sessionId, sessionRef: `ext_${randomUUID().replaceAll('-', '')}`, connectionId: connection.id,
      clientName: connection.name, workspace: await realpath(resolve(workspace)), permissionMode, profile, profileFile,
      status: 'open', createdAt: now, updatedAt: now,
    };
    this.sessionBindings.set(sessionId, record);
  }
  cancelPreparedSession(sessionId: string): void {
    this.sessionBindings.delete(sessionId);
  }
  private attachAgent(agent: IAgentScopeHandle, record: ExternalClientSession): void {
    const executor=agent.accessor.get(IAgentToolExecutorService);
    this.disposables.push(executor.registerBeforeResolveTool(async context=>{
      const grant=await this.store.active(record.connectionId).catch(()=>undefined);
      if(grant===undefined) return 'External connection is paused or revoked.';
      if(!grant.tools.includes(context.toolCall.name) || context.toolCall.name==='Bash' && !grant.allowCommands) return 'Tool is outside the external connection grant.';
      const mode=agent.accessor.get(IAgentPermissionModeService);
      mode.setModeCeiling(grant.mode);
      return undefined;
    }));
    this.disposables.push(executor.onBeforeExecuteTool(event=>{
      event.waitUntil(async()=>{
        const grant=await this.store.active(record.connectionId).catch(()=>undefined);
        if(grant===undefined) return {veto:{isError:true,output:'External connection is paused or revoked.'}};
        const home=await realpath(this.core.accessor.get(IBootstrapService).homeDir);
        for(const access of event.execution.accesses ?? []){
          if(access.kind==='all'){
            if(grant.allowCommands) continue;
            return {veto:{isError:true,output:'This operation requires explicit local-command access.'}};
          }
          const actual=await canonicalPath(access.path);
          const artifacts=join(home,agent.accessor.get(IAgentScopeContext).scope('tool-results'));
          if(access.operation==='read' && within(artifacts,actual)) continue;
          if((event.toolCall.name==='Glob'||event.toolCall.name==='Grep')&&within(actual,home))
            return {veto:{isError:true,output:'Narrow the search path to a folder outside the private Kiki home.'}};
          if(!within(record.workspace,actual) || within(home,actual))
            return {veto:{isError:true,output:'File access is outside the shared workspace.'}};
        }
        return undefined;
      });
    }));
  }
  async createConnection(raw: unknown) {
    const input=connectionInputSchema.parse(raw);
    const workspace=input.workspace===undefined?undefined:await realpath(resolve(input.workspace));
    const now=Date.now();
    const connection:ExternalClientConnection={id:`client_${randomUUID().replaceAll('-','')}`,name:input.name,workspace,
      mode:input.mode??'manual',tools:input.tools??[...DEFAULT_EXTERNAL_TOOLS],allowCommands:input.allowCommands??false,
      memoryScopes:input.memoryScopes??['workspace'],historyScope:input.historyScope??'current',status:'active',createdAt:now,updatedAt:now};
    if(connection.allowCommands && !connection.tools.includes('Bash')) connection.tools.push('Bash');
    await this.store.saveConnection(connection);
    return {connection,stdio:this.stdio(connection.id)};
  }
  async patchConnection(id:string,raw:unknown){
    const input=connectionPatchSchema.parse(raw);const current=await this.store.connection(id);
    if(current.status==='revoked') throw new ExternalClientError('connection_revoked','Create a new connection after revocation.');
    const {enabled,...patch}=input;
    const next={...current,...patch,workspace:patch.workspace===undefined?current.workspace:await realpath(resolve(patch.workspace)),
      status:enabled===undefined?current.status:enabled?'active' as const:'paused' as const,updatedAt:Date.now()};
    if(next.allowCommands && !next.tools.includes('Bash')) next.tools=[...next.tools,'Bash'];
    const policyChanged=policyFingerprint(next)!==policyFingerprint(current);
    await this.store.saveConnection(next);
    if(policyChanged) {
      for(const record of await this.store.sessions(id)) await this.stopSession(record.sessionId);
      await this.refreshCatalog(next);
      for(const listener of this.catalogListeners) listener(id);
    }
    return {connection:next};
  }
  stdio(id:string){return {command:'kiki',args:['mcp','--client',id,'--tools']};}
  async resolveGrant(id:string):Promise<ExternalClientGrant|null>{
    const connection=await this.store.active(id).catch(()=>undefined);
    return connection===undefined?null:{id:connection.id,resource:'kiki',audience:'kiki',scopes:['tools'],metadata:{name:connection.name}};
  }
  async resolveBearer(token:string):Promise<ExternalClientGrant|null>{
    const connection=await this.store.resolveBearer(token);return connection===undefined?null:this.resolveGrant(connection.id);
  }
  async catalog(grant:ExternalClientGrant):Promise<readonly ExternalClientToolDescriptor[]>{
    const connection=await this.store.active(grant.id);
    const tools=await this.store.documents.get<ExternalClientToolDescriptor[]>(this.store.scope,`external-clients/catalog/${connection.id}`);
    return [...controlTools(),...(tools??[]).filter(tool=>connection.tools.includes(tool.name)&&(tool.name!=='Bash'||connection.allowCommands))];
  }
  async refreshCatalog(connection:ExternalClientConnection,
    attached?: Awaited<ReturnType<ISessionManager['create']>>):Promise<void>{
    const manager=this.core.accessor.get(ISessionManager);
    const records=await this.store.sessions(connection.id);
    const session=attached??records.filter(record=>record.status==='open')
      .map(record=>manager.get(record.sessionId)).find(handle=>handle!==undefined);
    if(session===undefined) return;
    const main=await ensureMainAgent(session);
    const policy=main.accessor.get(IAgentToolPolicyService);
    const tools=main.accessor.get(IAgentToolRegistryService).list().filter(tool=>connection.tools.includes(tool.name)&&
      (tool.name!=='Bash'||connection.allowCommands)&&policy.isToolActive(tool.name,tool.source)).map(tool=>({name:tool.name,
      description:`${tool.description}\nUse _kiki.session_ref from kiki_session list/resume. Side effects require _kiki.idempotency_key.`,
      inputSchema:{...tool.parameters,properties:{...tool.parameters?.['properties'] as object,_kiki:bridgeSchema()}},
      annotations:{readOnlyHint:READ_ONLY_EXTERNAL_TOOLS.has(tool.name),destructiveHint:!READ_ONLY_EXTERNAL_TOOLS.has(tool.name),openWorldHint:tool.name==='Bash'||tool.name==='AgentRun'}}));
    await this.store.documents.set(this.store.scope,`external-clients/catalog/${connection.id}`,tools);
    for (const listener of this.catalogListeners) listener(connection.id);
  }
  async call(grant:ExternalClientGrant,name:string,raw:Record<string,unknown>,meta:ExternalClientCallMeta,_signal:AbortSignal):Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult>{
    const result=await this.dispatch(grant,name,raw,meta);
    if(typeof result==='object'&&result!==null&&'content' in result) return result as import('@modelcontextprotocol/sdk/types.js').CallToolResult;
    const structuredContent=result as Record<string,unknown>;
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent};
  }
  private async dispatch(grant:ExternalClientGrant,name:string,raw:Record<string,unknown>,meta:ExternalClientCallMeta):Promise<unknown>{
    const connection=await this.store.active(grant.id);
    if(name==='kiki_operation') return this.operation(connection,raw);
    const {_kiki,...args}=raw;
    const parsedBridge=bridgeInputSchema.safeParse(_kiki??{});
    if(!parsedBridge.success)throw new ExternalClientError('invalid_bridge','Supply valid _kiki.session_ref and an idempotency_key of 1–256 characters.');
    const bridge=parsedBridge.data;
    if(name==='kiki_save_text'&&!saveTextSchema.safeParse(args).success)throw new ExternalClientError('invalid_saved_text','Supply text, an allowed kind, and valid optional source fields.');
    const conversation=meta._meta?.['openai/session'];
    const conversationKey=typeof conversation==='string'&&conversation.length>0&&conversation.length<=512?conversation:undefined;
    if(name==='kiki_session') return this.sessionControl(connection,args,bridge,conversationKey);
    if(name!=='kiki_save_text'&&!connection.tools.includes(name)) throw new ExternalClientError('tool_unavailable','Tool is not shared with this connection.');
    if(!READ_ONLY_EXTERNAL_TOOLS.has(name)&&!bridge.idempotency_key) throw new ExternalClientError('idempotency_required','Supply a stable _kiki.idempotency_key and reuse it on retries.');
    const session=await this.resolveSession(connection,bridge.session_ref,conversationKey);
    const admitted=await this.store.admit(connection.id,session.sessionRef,name,args,bridge.idempotency_key);
    if(!admitted.duplicate) this.launch(session,admitted.operation);
    const active=this.running.get(admitted.operation.id);
    if(active!==undefined) await Promise.race([active.done,new Promise<void>(resolve=>{setTimeout(resolve,100);})]);
    return receipt((await this.store.operation(admitted.operation.id))!,admitted.duplicate);
  }
  private async resolveSession(connection:ExternalClientConnection,ref?:string,conversationKey?:string):Promise<ExternalClientSession>{
    if(conversationKey===undefined&&ref===undefined) throw new ExternalClientError('session_required','Select a shared session with kiki_session list/resume, then pass its session_ref in _kiki.');
    return this.store.serialize(async()=>{
      const mapped=conversationKey===undefined?undefined:(await this.store.sessions(connection.id)).find(s=>s.conversationKey===conversationKey);
      if(mapped!==undefined && ref!==undefined && mapped.sessionRef!==ref) throw new ExternalClientError('session_conflict','Conversation metadata and explicit reference target different sessions.');
      if(mapped===undefined && conversationKey!==undefined && ref!==undefined) throw new ExternalClientError('session_conflict','A new conversation cannot silently reuse a copied session reference. Use kiki_session resume explicitly.');
      const session=mapped??(ref===undefined?await this.newSession(connection,conversationKey):await this.store.session(connection.id,ref));
      if(session.status==='closed') throw new ExternalClientError('session_closed','Session is closed. Explicitly resume it before calling tools.');
      return session;
    });
  }
  private async newSession(connection:ExternalClientConnection,conversationKey?:string,sourceRef?:string):Promise<ExternalClientSession>{
    const selected=sourceRef===undefined?undefined:await this.store.session(connection.id,sourceRef);
    const workspace=selected?.workspace??connection.workspace;
    if(workspace===undefined) throw new ExternalClientError('session_required','Create a session in Kiki with this connection and a workspace, or select its session_ref from kiki_session list.');
    const now=Date.now();const sessionId=`session_${randomUUID().replaceAll('-','')}`;
    let record:ExternalClientSession={sessionId,sessionRef:`ext_${randomUUID().replaceAll('-','')}`,connectionId:connection.id,
      clientName:connection.name,workspace,permissionMode:selected?.permissionMode??connection.mode,
      profile:selected?.profile,profileFile:selected?.profileFile,
      conversationKey,status:'open',createdAt:now,updatedAt:now};
    this.sessionBindings.set(sessionId,record);
    let session: Awaited<ReturnType<ISessionManager['create']>>;
    try {
      session=await this.core.accessor.get(ISessionManager).create({sessionId,workDir:workspace,
        mainAgentBinding:{driver:'external',profile:record.profile,
          execution:record.profileFile===undefined?undefined:{executor:'native',profile_file:record.profileFile}}});
    } catch(error) {
      this.cancelPreparedSession(sessionId);
      throw error;
    }
    record={...record,workspaceId:session.accessor.get(ISessionContext).workspaceId};
    this.sessionBindings.set(sessionId,record);await this.store.saveSession(record);
    const mode=(await ensureMainAgent(session)).accessor.get(IAgentPermissionModeService);
    mode.setModeCeiling(connection.mode);
    mode.setMode(record.permissionMode??connection.mode);
    await session.accessor.get(ISessionMetadata).setTitle(`${connection.name} · external`);
    return record;
  }
  private async sessionControl(connection:ExternalClientConnection,args:Record<string,unknown>,bridge:{session_ref?:string;idempotency_key?:string},conversationKey?:string){
    if(args['action']==='list') return {sessions:await this.store.sessions(connection.id)};
    if(args['action']==='new'){
      if(!bridge.idempotency_key) throw new ExternalClientError('idempotency_required','New sessions require _kiki.idempotency_key.');
      const sourceRef=typeof args['session_ref']==='string'?args['session_ref']:bridge.session_ref;
      if(sourceRef===undefined&&connection.workspace===undefined)
        throw new ExternalClientError('session_required','Create a session in Kiki with this connection and a workspace, then select its session_ref.');
      if(sourceRef!==undefined) await this.store.session(connection.id,sourceRef);
      const admitted=await this.store.admit(connection.id,'new','kiki_session',{...args,sourceRef,conversationKey},bridge.idempotency_key);
      if(admitted.duplicate) return admitted.operation.state==='completed'?{...(admitted.operation.result as ExternalClientSession),session_ref:(admitted.operation.result as ExternalClientSession).sessionRef,duplicate:true}:receipt(admitted.operation,true);
      const session=await this.store.serialize(async()=>{
        const created=await this.newSession(connection,conversationKey,sourceRef);
        if(conversationKey!==undefined) for(const old of await this.store.sessions(connection.id))
          if(old.conversationKey===conversationKey&&old.sessionRef!==created.sessionRef)
            await this.store.saveSession({...old,conversationKey:undefined});
        return created;
      });
      const operation={...admitted.operation,state:'completed' as const,result:session,updatedAt:Date.now()};await this.store.saveOperation(operation);
      return {...session,session_ref:session.sessionRef,operationId:operation.id};
    }
    if(args['action']==='resume'){
      const ref=typeof args['session_ref']==='string'?args['session_ref']:bridge.session_ref;
      if(ref===undefined) throw new ExternalClientError('session_required','Select a session_ref from kiki_session list.');
      const record=await this.store.serialize(async()=>{
        const prior=await this.store.session(connection.id,ref);
        if(conversationKey!==undefined) for(const old of await this.store.sessions(connection.id)) if(old.conversationKey===conversationKey&&old.sessionRef!==ref)
          await this.store.saveSession({...old,conversationKey:undefined});
        const next={...prior,status:'open' as const,conversationKey:conversationKey??prior.conversationKey,updatedAt:Date.now()};
        await this.store.saveSession(next);return next;
      });
      this.sessionBindings.set(record.sessionId,record);
      return {...record,session_ref:record.sessionRef};
    }
    if(args['action']==='close'){
      const session=await this.resolveSession(connection,bridge.session_ref,conversationKey);return this.closeSession(session.sessionId);
    }
    throw new ExternalClientError('invalid_action','Choose new, resume, list, or close.');
  }
  private launch(session:ExternalClientSession,operation:ExternalClientOperation):void{
    const controller=new AbortController();
    const prior=this.queues.get(session.sessionId)??Promise.resolve();
    const done=prior.catch(()=>undefined).then(()=>this.execute(session,operation,controller.signal)).finally(()=>this.running.delete(operation.id));
    this.running.set(operation.id,{controller,done});this.queues.set(session.sessionId,done);
    void done.catch(()=>undefined);
  }
  private async execute(record:ExternalClientSession,operation:ExternalClientOperation,signal:AbortSignal):Promise<void>{
    let recorder:ExternalClientRecorder|undefined;
    let executionEntered=false;
    try{
      signal.throwIfAborted();await this.store.active(operation.connectionId);
      await this.store.saveOperation({...operation,state:'running',updatedAt:Date.now()});
      await withSessionOperation(this.core,record.sessionId,async session=>{
        if(session===undefined) throw new ExternalClientError('session_unavailable','Session is unavailable.');
        const main=await ensureMainAgent(session);
        const mode=main.accessor.get(IAgentPermissionModeService);const grant=await this.store.active(record.connectionId);
        mode.setModeCeiling(grant.mode);
        if(record.permissionMode===undefined) mode.setMode(grant.mode);
        recorder=new ExternalClientRecorder(main,{driver:'external',connectionId:record.connectionId,clientName:record.clientName,sessionRef:record.sessionRef,operationId:operation.id,toolCallId:operation.id});
        await recorder.begin(operation.name,operation.name==='kiki_save_text'?{kind:operation.arguments['kind'],title:operation.arguments['title']}:operation.arguments);
        let result:unknown;
        executionEntered=true;
        if(operation.name==='kiki_save_text') result={...await recorder.saveText(saveTextSchema.parse(operation.arguments)),sessionRef:record.sessionRef,savedAt:Date.now()};
        else{
          const interaction=session.accessor.get(ISessionInteractionService);
          let approvalWrite=Promise.resolve();
          const changed=interaction.onDidChangePending(()=>{
            if(interaction.listPending('approval',{agentId:main.id}).length>0) approvalWrite=approvalWrite.then(()=>this.store.saveOperation({...operation,state:'waiting_approval',updatedAt:Date.now()}));
          });
          try{
            for await(const executed of main.accessor.get(IAgentToolExecutorService).execute([{id:operation.id,type:'function',name:operation.name,arguments:JSON.stringify(operation.arguments)}],
              {signal,turnId:recorder.turnId,onToolCall:payload=>{recorder!.toolCall(payload);}})){
              await recorder.toolResult(executed);result=executed.result;break;
            }
          }finally{await changed.dispose();await approvalWrite;}
        }
        if(result===undefined) throw new ExternalClientError('missing_result','Native tool returned no result.');
        const failed=typeof result==='object'&&result!==null&&'isError' in result&&result.isError===true;
        await recorder.end(signal.aborted?'cancelled':failed?'failed':'completed');
        await this.store.touchSession(record);
        await this.store.saveOperation({...operation,state:signal.aborted?'cancelled':'completed',result,updatedAt:Date.now()});
      });
    }catch(error){
      const aborted=signal.aborted;
      await recorder?.end(aborted?'cancelled':'failed').catch(()=>undefined);
      await this.store.saveOperation({...operation,state:executionEntered?'outcome_unknown':aborted?'cancelled':'failed',error:error instanceof Error?error.message:String(error),updatedAt:Date.now()});
    }
  }
  private async operation(connection:ExternalClientConnection,args:Record<string,unknown>){
    const operation=typeof args['operation_id']==='string'?await this.store.operation(args['operation_id']):undefined;
    if(operation===undefined||operation.connectionId!==connection.id) throw new ExternalClientError('operation_unavailable','Operation is not shared with this connection.');
    if(args['action']==='read') return import('./resultPages').then(async ({readOperationResult})=>readOperationResult(this.core,operation,await this.store.session(connection.id,operation.sessionRef),args));
    if(args['action']==='cancel') this.running.get(operation.id)?.controller.abort();
    return receipt((await this.store.operation(operation.id))!,false);
  }
  async stopSession(id:string){
    const record=await this.store.sessionById(id);if(record===undefined) throw new ExternalClientError('session_unavailable','External session is unavailable.');
    const drained:Promise<void>[]=[];
    for(const [opId,running] of this.running){const op=await this.store.operation(opId);if(op?.sessionRef===record.sessionRef){running.controller.abort();drained.push(running.done);}}
    await withSessionOperation(this.core,id,async session=>{if(session!==undefined) for(const agent of session.accessor.get(IAgentLifecycleService).list()) {
      agent.accessor.get(IAgentLoopService).cancel(undefined,'External session stopped');
      await agent.accessor.get(IAgentTaskService).stopAll('External session stopped');
    }});
    await Promise.allSettled(drained);
    return {session:record};
  }
  async closeSession(id:string){const record=await this.store.sessionById(id);if(record===undefined)throw new ExternalClientError('session_unavailable','External session is unavailable.');
    const next={...record,status:'closed' as const,updatedAt:Date.now()};await this.store.saveSession(next);await this.stopSession(id);return {session:next};}
  async revoke(id:string){const prior=await this.store.connection(id);const connection={...prior,status:'revoked' as const,updatedAt:Date.now()};
    await this.store.saveConnection(connection);for(const record of await this.store.sessions(id)) await this.stopSession(record.sessionId);return {connection};}
  async saveOwnerText(id:string,body:Record<string,unknown>){
    const record=await this.store.sessionById(id);if(record===undefined)throw new ExternalClientError('session_unavailable','External session is unavailable.');
    const {idempotencyKey,relatedOperationIds,...args}=body;
    const grant=await this.resolveGrant(record.connectionId);if(grant===null)throw new ExternalClientError('connection_unavailable','External connection is paused or revoked.');
    const response=await this.call(grant,'kiki_save_text',{...args,related_operation_ids:relatedOperationIds,
      _kiki:{session_ref:record.sessionRef,idempotency_key:idempotencyKey}},{requestId:randomUUID()},new AbortController().signal);
    const operationId=String(response.structuredContent?.['operation_id']);
    await this.running.get(operationId)?.done;
    const operation=await this.store.operation(operationId);
    if(operation?.state!=='completed')throw new ExternalClientError(operation?.state??'save_failed',operation?.error??'The note was not saved.');
    return {...operation.result as object,sessionRef:record.sessionRef,savedAt:operation.updatedAt,duplicate:response.structuredContent?.['duplicate']===true};
  }
  async continueSession(id:string,title?:string){const record=await this.store.sessionById(id);if(record===undefined)throw new ExternalClientError('session_unavailable','External session is unavailable.');
    for(const opId of this.running.keys())if((await this.store.operation(opId))?.sessionRef===record.sessionRef)
      throw new ExternalClientError('session_busy','Finish or stop the external operation before continuing locally.');
    const fork=await this.core.accessor.get(ISessionManager).fork({sourceSessionId:id,title,externalMaterialOnly:true});
    const metadata=fork.accessor.get(ISessionMetadata);const current=await metadata.read();const custom={...current.custom};delete custom['externalClient'];
    await metadata.update({custom:{...custom,externalSource:{sessionId:id,sessionRef:record.sessionRef}}});return {sessionId:fork.id};}
  async close():Promise<void>{for(const running of this.running.values())running.controller.abort();await Promise.allSettled([...this.running.values()].map(r=>r.done));
    for(const disposable of this.disposables)disposable.dispose();
    this.catalogListeners.clear();}
}
function policyFingerprint(connection:ExternalClientConnection):string {
  const workspace=connection.workspace===undefined?undefined:resolve(connection.workspace);
  return JSON.stringify({workspace:process.platform==='win32'?workspace?.toLocaleLowerCase('en-US'):workspace,
    mode:connection.mode,tools:[...new Set(connection.tools)].toSorted(),allowCommands:connection.allowCommands,
    memoryScopes:[...new Set(connection.memoryScopes)].toSorted(),historyScope:connection.historyScope,status:connection.status});
}
function bridgeSchema(){return {type:'object',properties:{session_ref:{type:'string'},idempotency_key:{type:'string',minLength:1,maxLength:256}},additionalProperties:false};}
function controlTools():ExternalClientToolDescriptor[]{return[
  {name:'kiki_session',description:'List or explicitly resume sessions shared in Kiki. Create the first session in Kiki with a workspace; action=new with session_ref inherits that session’s workspace and settings. Transport initialization does not create a chat. Persist session_ref in _kiki on future calls.',inputSchema:{type:'object',properties:{action:{enum:['new','resume','list','close']},session_ref:{type:'string'},_kiki:bridgeSchema()},required:['action']},annotations:{readOnlyHint:false,destructiveHint:false}},
  {name:'kiki_operation',description:'Query/cancel an accepted operation without resubmitting. action=read pages the original saved result; part selects native output array content. Text ranges are UTF-16; media ranges are bytes, delivered as base64 resource chunks. Follow next until complete.',inputSchema:{type:'object',properties:{operation_id:{type:'string'},action:{enum:['get','cancel','read']},part:{type:'integer',minimum:0},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:256000}},required:['operation_id']},annotations:{readOnlyHint:false,destructiveHint:false}},
  {name:'kiki_save_text',description:'Save text explicitly provided by the external model, not automatically synchronized chat. kind=user_excerpt is a client-supplied excerpt, not verified human testimony. Stable idempotency key required.',inputSchema:{type:'object',properties:{text:{type:'string'},kind:{enum:['note','user_excerpt','assistant_excerpt','handoff']},title:{type:'string'},related_operation_ids:{type:'array',items:{type:'string'}},_kiki:bridgeSchema()},required:['text','kind']},annotations:{readOnlyHint:false,destructiveHint:false}},
];}
async function canonicalPath(path:string):Promise<string>{try{return await realpath(path);}catch{const parent=dirname(path);if(parent===path)return resolve(path);return resolve(await canonicalPath(parent),path.slice(parent.length+1));}}
