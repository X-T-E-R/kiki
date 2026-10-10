import type { ExternalClientsFacade } from '../../core/facade/external-clients.js';
import type { HttpRestTransport } from './rest.js';
export function createExternalClientsFacade(transport:HttpRestTransport):ExternalClientsFacade {
  const base='/external-clients';const at=(id:string)=>`${base}/${encodeURIComponent(id)}`;
  const session=(id:string)=>`${base}/sessions/${encodeURIComponent(id)}`;
  return {
    list:options=>transport.json(base,options),
    create:(body,options)=>transport.json(base,{...options,method:'POST',body}),
    update:(id,body,options)=>transport.json(at(id),{...options,method:'PATCH',body}),
    revoke:(id,options)=>transport.json(at(id),{...options,method:'DELETE'}),
    sessions:(id,options)=>transport.json(`${at(id)}/sessions`,options),
    stdio:(id,options)=>transport.json(`${at(id)}/stdio`,{...options,method:'POST',body:{}}),
    listener:options=>transport.json(`${base}/listener`,options),
    configureListener:(body,options)=>transport.json(`${base}/listener`,{...options,method:'PUT',body}),
    authorizations:options=>transport.json(`${base}/authorizations`,options),
    respondAuthorization:(id,body,options)=>transport.json(`${base}/authorizations/${encodeURIComponent(id)}/respond`,{...options,method:'POST',body}),
    saveText:(id,body,options)=>transport.json(`${session(id)}/text`,{...options,method:'POST',body}),
    materials:(id,options)=>transport.json(`${session(id)}/materials`,options),
    continue:(id,body,options)=>transport.json(`${session(id)}/continue`,{...options,method:'POST',body:body??{}}),
    closeSession:(id,options)=>transport.json(`${session(id)}/close`,{...options,method:'POST',body:{}}),
    stopSession:(id,options)=>transport.json(`${session(id)}/stop`,{...options,method:'POST',body:{}}),
  };
}
