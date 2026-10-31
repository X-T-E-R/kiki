import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { IAtomicDocumentStore, IBlobStore, IBootstrapService, IFileSystemStorageService, ISessionIndex, type Scope } from '@kiki/agent-core-v2';
import { ScopedMediaStore } from '@kiki/agent-core-v2/agent/media/sessionMediaStoreService';
import { workspacePersistenceScope, sessionScopeOf, agentScopeOf } from '@kiki/agent-core-v2/workspace/sessionLifecycle/internal/addressing';
import type { ExternalClientOperation, ExternalClientSession } from './contracts';
import { ExternalClientError } from './contracts';

export async function readOperationResult(core:Scope,operation:ExternalClientOperation,session:ExternalClientSession,args:Record<string,unknown>):Promise<CallToolResult> {
  if(operation.result===undefined)throw new ExternalClientError('result_unavailable','This operation has no saved result yet. Query its state first.');
  const offset=integer(args['offset'],0,Number.MAX_SAFE_INTEGER);
  const limit=integer(args['limit'],12_000,256_000);
  if(limit===0)throw new ExternalClientError('invalid_result_range','Use a positive page limit.');
  const result=operation.result as {output?:unknown};
  if(args['artifact']!==undefined) {
    if(args['part']!==undefined)throw new ExternalClientError('invalid_result_range','Choose either an artifact or an output part.');
    return readGeneratedArtifact(core,operation,session,integer(args['artifact'],0,10_000),offset,limit);
  }
  const partIndex=args['part']===undefined?undefined:integer(args['part'],0,10_000);
  const part=partIndex===undefined?undefined:Array.isArray(result.output)?result.output[partIndex]:undefined;
  if(partIndex!==undefined&&part===undefined)throw new ExternalClientError('result_part_unavailable','Select a saved output part from the operation receipt.');
  const url=part?.imageUrl?.url??part?.audioUrl?.url??part?.videoUrl?.url;
  let bytes:Uint8Array|undefined;
  let mime='application/octet-stream';
  if(typeof url==='string') {
    const inline=/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if(inline!==null){mime=inline[1]!;bytes=Buffer.from(inline[2]!,'base64');}
    else {
      const blob=/^blobref:([^;\s/]+\/[^;\s]+);([0-9a-f]{64})$/.exec(url);
      if(blob===null||session.workspaceId===undefined)
        throw new ExternalClientError('media_unavailable','This saved part has no historical byte reference; it is not read from the current host file.');
      const scope=`${agentScopeOf(sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'),session.workspaceId),session.sessionId),'main')}/blobs`;
      mime=blob[1]!;
      bytes=await core.accessor.get(IBlobStore).get(scope,blob[2]!);
      if(bytes===undefined)throw new ExternalClientError('media_unavailable','Historical bytes are unavailable.');
    }
  }
  const text=bytes===undefined?(partIndex===undefined?JSON.stringify(operation.result):typeof part.text==='string'?part.text:JSON.stringify(part)):undefined;
  const total=bytes?.byteLength??text!.length;
  const end=Math.min(total,offset+limit);
  if(offset>total)throw new ExternalClientError('invalid_result_range','Offset exceeds the saved result length.');
  const structuredContent={operation_id:operation.id,session_ref:session.sessionRef,part:partIndex,range:{start:offset,end,total,unit:bytes===undefined?'utf16':'bytes'},complete:end===total,next:end===total?undefined:{tool:'kiki_operation',arguments:{operation_id:operation.id,action:'read',part:partIndex,offset:end,limit}}};
  const content:CallToolResult['content']=[{type:'text',text:JSON.stringify(structuredContent)}];
  if(bytes!==undefined)content.push({type:'resource',resource:{uri:`kiki:operation/${operation.id}/${partIndex}/${offset}`,mimeType:mime,blob:Buffer.from(bytes.subarray(offset,end)).toString('base64')}});
  else content.push({type:'text',text:text!.slice(offset,end)});
  return {content,structuredContent};
}
function integer(value:unknown,fallback:number,max:number):number {
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new ExternalClientError('invalid_result_range','Use a nonnegative integer offset/part and a limit up to 256000.');
  return value;
}

async function readGeneratedArtifact(core:Scope,operation:ExternalClientOperation,session:ExternalClientSession,index:number,offset:number,limit:number):Promise<CallToolResult> {
  const output=(operation.result as {output?:unknown}).output;
  const texts=typeof output==='string'?[output]:Array.isArray(output)?output.flatMap(part=>part?.type==='text'&&typeof part.text==='string'?[part.text]:[]):[];
  let artifact:{file_id:string}|undefined;
  for(const text of texts) {
    let parsed:unknown;
    try { parsed=JSON.parse(text); } catch { continue; }
    if(typeof parsed!=='object'||parsed===null||!('type' in parsed)||parsed.type!=='media_generation'||!('job' in parsed))continue;
    const job=parsed.job;
    if(typeof job!=='object'||job===null||!('artifacts' in job)||!Array.isArray(job.artifacts))continue;
    const candidate:unknown=job.artifacts[index];
    if(typeof candidate==='object'&&candidate!==null&&'file_id' in candidate&&typeof candidate.file_id==='string')artifact={file_id:candidate.file_id};
    break;
  }
  if(artifact===undefined)throw new ExternalClientError('artifact_unavailable','Select an artifact index from a saved media job result. Query the media job again after generation finishes.');
  const workspaceId=session.workspaceId??(await core.accessor.get(ISessionIndex).get(session.sessionId))?.workspaceId;
  if(workspaceId===undefined)throw new ExternalClientError('artifact_unavailable','The artifact session is unavailable.');
  const scope=sessionScopeOf(workspacePersistenceScope(core.accessor.get(IBootstrapService).scope('sessions'),workspaceId),session.sessionId);
  const media=new ScopedMediaStore(`${scope}/media`,core.accessor.get(IFileSystemStorageService),core.accessor.get(IAtomicDocumentStore));
  const file=await media.open(artifact.file_id);
  if(file===undefined)throw new ExternalClientError('artifact_unavailable','The generated artifact is unavailable in this session.');
  if(offset>file.size)throw new ExternalClientError('invalid_result_range','Offset exceeds the saved artifact length.');
  const end=Math.min(file.size,offset+limit);
  const chunks:Buffer[]=[];
  if(end>offset)for await(const chunk of file.stream({start:offset,end:end-1}))chunks.push(Buffer.from(chunk));
  const structuredContent={operation_id:operation.id,session_ref:session.sessionRef,artifact:index,name:file.name,mime:file.mediaType,
    range:{start:offset,end,total:file.size,unit:'bytes'},complete:end===file.size,
    next:end===file.size?undefined:{tool:'kiki_operation',arguments:{operation_id:operation.id,action:'read',artifact:index,offset:end,limit}}};
  return {structuredContent,content:[{type:'text',text:JSON.stringify(structuredContent)},
    {type:'resource',resource:{uri:`kiki:operation/${operation.id}/artifact/${index}/${offset}`,mimeType:file.mediaType,blob:Buffer.concat(chunks).toString('base64')}}]};
}
