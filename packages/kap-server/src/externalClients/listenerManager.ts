import { createExternalClientListener, type ExternalClientListener } from '../mcp/externalClientTransport/listener';
import type { ExternalClientTransportHost } from '../mcp/externalClientTransport/host';
import type { ExternalClientHost } from './host';
import type { ExternalClientListenerManager } from './routes';
import { ExternalClientError } from './contracts';

interface ListenerConfig { enabled:boolean;host?:string;port?:number;publicUrl?:string }
export class NativeExternalClientListenerManager implements ExternalClientListenerManager {
  private listener:ExternalClientListener|undefined;
  private config:ListenerConfig={enabled:false};
  private error:string|undefined;
  private mutation:Promise<unknown>=Promise.resolve();
  constructor(private readonly host:ExternalClientHost){}
  async initialize():Promise<void>{
    const config=await this.host.store.documents.get<ListenerConfig>(this.host.store.scope,'external-clients/listener');
    if(config?.enabled) await this.configure(config);
  }
  status(){const address=this.listener?.address();return {enabled:this.config.enabled,state:this.error?'error' as const:address?'listening' as const:'stopped' as const,
    origin:address?.origin,mcpUrl:address===undefined?undefined:`${this.config.publicUrl??address.origin}/mcp`,publicUrl:this.config.publicUrl,
    discovery:'unchecked' as const,error:this.error};}
  configure(input:ListenerConfig):Promise<ReturnType<NativeExternalClientListenerManager['status']>>{
    const work=async()=>{
      const publicOrigin=input.publicUrl===undefined?undefined:new URL(input.publicUrl);
      if(publicOrigin!==undefined&&publicOrigin.protocol!=='https:')throw new ExternalClientError('https_required','Use a stable HTTPS public URL. Local clients do not need a public URL.');
      if(publicOrigin!==undefined&&(publicOrigin.username||publicOrigin.password||publicOrigin.pathname!=='/'||publicOrigin.search||publicOrigin.hash))throw new ExternalClientError('invalid_public_origin','Public URL must be an HTTPS origin without credentials, path, query, or fragment.');
      const config={...input,publicUrl:publicOrigin?.origin};
      await this.listener?.close();this.listener=undefined;this.config=config;this.error=undefined;
      await this.host.store.documents.set(this.host.store.scope,'external-clients/listener',config);
      if(input.enabled){
        const resolve=(id:string)=>this.grant(id);
        const transport:ExternalClientTransportHost={oauthStore:this.host.store.documents,oauthStoreScope:this.host.store.scope,
          resolveBearer:async token=>{const grant=await this.host.resolveBearer(token);return grant===null?null:resolve(grant.id);},
          resolveGrant:resolve,catalog:grant=>this.host.catalog(grant),onCatalogChanged:listener=>this.host.onCatalogChanged(listener),
          call:(grant,name,args,meta,signal)=>this.host.call(grant,name,args,meta,signal)};
        this.listener=createExternalClientListener({host:transport,bindHost:input.host??'127.0.0.1',port:input.port??0,publicUrl:config.publicUrl,
          oauthOptions:{store:this.host.store.documents,storeScope:`${this.host.store.scope}/external-clients/oauth`,scopesSupported:['tools']}});
        try{await this.listener.start();}catch(error){this.error=error instanceof Error?error.message:String(error);await this.listener.close().catch(()=>undefined);this.listener=undefined;}
      }
      return this.status();
    };
    const next=this.mutation.then(work,work);this.mutation=next.catch(()=>undefined);return next;
  }
  private async grant(id:string){
    const grant=await this.host.resolveGrant(id);if(grant===null)return null;
    const origin=this.config.publicUrl??this.listener?.address()?.origin;
    if(origin===undefined)return null;
    const resource=`${origin.replace(/\/$/,'')}/mcp`;
    return {...grant,resource,audience:resource,status:'active' as const};
  }
  async authorizations():Promise<unknown[]>{return [...await this.listener?.oauth?.listPending()??[]];}
  async respondAuthorization(id:string,body:{connectionId:string;approved:boolean}){
    if(this.listener?.oauth===undefined)throw new ExternalClientError('listener_unavailable','Start the MCP listener before authorizing a client.');
    await this.listener.oauth.respondPending(id,body);return {approved:body.approved};
  }
  async ensureLocal():Promise<string>{
    if(this.listener===undefined)await this.configure({...this.config,enabled:true,host:'127.0.0.1'});
    const address=this.listener?.address();if(address===undefined)throw new ExternalClientError('listener_unavailable',this.error??'MCP listener is unavailable.');
    const host=address.host==='0.0.0.0'||address.host==='::'?'127.0.0.1':address.host;
    return `http://${host.includes(':')?`[${host}]`:host}:${address.port}/mcp`;
  }
  async close():Promise<void>{await this.listener?.close();this.listener=undefined;}
}
