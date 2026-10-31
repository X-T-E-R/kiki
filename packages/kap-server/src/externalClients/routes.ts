import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IPluginHostService, IPluginService } from '@kiki/agent-core-v2';
import { z } from 'zod';
import { okEnvelope, errEnvelope } from '../envelope';
import { ExternalClientError } from './contracts';
import type { ExternalClientHost } from './host';
import type { TranscriptService } from '../services/transcript/transcriptService';
import { previewExternalClientMaterials } from './materials';

export interface ExternalClientListenerManager {
  status(): {enabled:boolean;state:'stopped'|'listening'|'error';origin?:string;mcpUrl?:string;publicUrl?:string;discovery?:'unchecked'|'reachable'|'failed';error?:string};
  configure(input:{enabled:boolean;host?:string;port?:number;publicUrl?:string}):Promise<unknown>;
  authorizations():Promise<unknown[]>;
  respondAuthorization(id:string,body:{connectionId:string;approved:boolean}):Promise<unknown>;
  ensureLocal():Promise<string>;
}
export function registerExternalClientRoutes(app:FastifyInstance,host:ExternalClientHost,listener:ExternalClientListenerManager,enabled:()=>boolean,transcript:TranscriptService):void {
  const path='/external-clients';
  const invoke=(handler:(request:FastifyRequest)=>Promise<unknown>)=>async(request:FastifyRequest,reply:import('fastify').FastifyReply)=>{
    if(!enabled())return reply.send(errEnvelope(40001,'External clients are disabled. Enable experimental.external_clients to use this capability.',request.id));
    try{return await reply.send(okEnvelope(await handler(request),request.id));}
    catch(error){if(error instanceof ExternalClientError||error instanceof z.ZodError)return reply.send({...errEnvelope(40001,error.message,request.id),details:{code:error instanceof ExternalClientError?error.code:'invalid_input'}});throw error;}
  };
  const id=(request:FastifyRequest)=>z.object({id:z.string()}).parse(request.params).id;
  app.get(path,invoke(async()=>{
    const [connections,plugins,registrations]=await Promise.all([
      host.store.connections(),host.core.accessor.get(IPluginService).listPlugins(),host.core.accessor.get(IPluginHostService).list(),
    ]);
    const toolCatalog=plugins.filter(plugin=>registrations.some(tool=>tool.pluginId===plugin.id)).map(plugin=>({
      pluginId:plugin.id,displayName:plugin.displayName,tools:registrations.filter(tool=>tool.pluginId===plugin.id).map(({definition})=>({
        name:`plugin__${plugin.id.replaceAll('-','_')}__${definition.name}`,requiresCommands:definition.accesses.some(access=>access.kind==='all'),
      })),
    }));
    return {connections,listener:listener.status(),toolCatalog};
  }));
  app.post(path,invoke(request=>host.createConnection(request.body)));
  app.patch(`${path}/:id`,invoke(request=>host.patchConnection(id(request),request.body)));
  app.delete(`${path}/:id`,invoke(request=>host.revoke(id(request))));
  app.get(`${path}/:id/sessions`,invoke(async request=>({sessions:await host.store.sessions(id(request))})));
  app.post(`${path}/:id/stdio`,invoke(async request=>{await host.store.active(id(request));return host.stdio(id(request));}));
  app.post(`${path}/:id/credential`,invoke(async request=>{
    const address=request.socket.remoteAddress;
    if(address!=='127.0.0.1'&&address!=='::1'&&address!=='::ffff:127.0.0.1')throw new ExternalClientError('local_only','Local MCP credentials require a loopback owner connection.');
    return {...await host.store.credential(id(request)),mcpUrl:await listener.ensureLocal()};
  }));
  app.get(`${path}/listener`,invoke(async()=>listener.status()));
  app.put(`${path}/listener`,invoke(request=>listener.configure(z.object({enabled:z.boolean(),host:z.string().optional(),port:z.number().int().min(0).max(65535).optional(),publicUrl:z.string().url().optional()}).strict().parse(request.body))));
  app.get(`${path}/authorizations`,invoke(async()=>({authorizations:await listener.authorizations()})));
  app.post(`${path}/authorizations/:id/respond`,invoke(request=>listener.respondAuthorization(id(request),z.object({connectionId:z.string(),approved:z.boolean()}).strict().parse(request.body))));
  app.post(`${path}/sessions/:id/text`,invoke(request=>host.saveOwnerText(id(request),z.object({text:z.string().min(1),kind:z.enum(['note','user_excerpt','assistant_excerpt','handoff']),title:z.string().optional(),idempotencyKey:z.string().min(1),relatedOperationIds:z.array(z.string()).optional()}).strict().parse(request.body))));
  app.get(`${path}/sessions/:id/materials`,invoke(request=>previewExternalClientMaterials(host.store,transcript,id(request))));
  app.post(`${path}/sessions/:id/continue`,invoke(request=>host.continueSession(id(request),z.object({title:z.string().optional()}).strict().parse(request.body??{}).title)));
  app.post(`${path}/sessions/:id/close`,invoke(request=>host.closeSession(id(request))));
  app.post(`${path}/sessions/:id/stop`,invoke(request=>host.stopSession(id(request))));
}
