import type { ExternalClientSource, ExternalTextRecord } from '@kiki/transcript';
import type { TranscriptService } from '../services/transcript/transcriptService';
import type { ExternalClientStore } from './store';
import { ExternalClientError } from './contracts';

export interface ExternalClientMaterial {
  readonly id:string;
  readonly kind:'saved_text'|'tool_record';
  readonly title:string;
  readonly excerpt:string;
  readonly source:ExternalClientSource;
  readonly recordKind?:ExternalTextRecord['kind'];
  readonly toolName?:string;
  readonly history:{readonly sessionId:string;readonly agentId:'main';readonly turn:number};
}
export interface ExternalClientMaterialsPreview {
  readonly state:'complete'|'partial'|'unloaded';
  readonly sessionId:string;
  readonly items:readonly ExternalClientMaterial[];
  readonly knownTotal?:number;
  readonly coverage:{readonly complete:boolean;readonly bytesRead:number;readonly recordsRead:number;readonly reason?:string};
}
const MAX_ITEMS=12;
const MAX_EXCERPT=300;
export async function previewExternalClientMaterials(store:Pick<ExternalClientStore,'sessionById'>,transcript:Pick<TranscriptService,'readColdSnapshotBounded'>,sessionId:string):Promise<ExternalClientMaterialsPreview> {
  const record=await store.sessionById(sessionId);
  if(record===undefined)throw new ExternalClientError('session_unavailable','External session is unavailable.');
  const scan=await transcript.readColdSnapshotBounded(sessionId,'main',{maxBytes:2<<20,maxRecords:10_000,maxLineBytes:1_200_000,chunkBytes:64<<10});
  if(scan.snapshot===undefined)return {state:'unloaded',sessionId,items:[],coverage:{complete:false,bytesRead:scan.bytesRead,recordsRead:scan.recordsRead,reason:scan.incompleteReason??'source_unavailable'}};
  const source:ExternalClientSource={connectionId:record.connectionId,clientName:record.clientName,sessionRef:record.sessionRef,driver:'external'};
  const items:ExternalClientMaterial[]=[];
  for(const item of scan.snapshot.items){
    if(item.kind==='marker'&&item.marker==='external.text'){
      const text=item.payload as ExternalTextRecord|undefined;
      if(text===undefined||typeof text.text!=='string'||typeof text.turnId!=='number')continue;
      items.push({id:text.recordId,kind:'saved_text',title:text.title??text.kind,excerpt:text.text.slice(0,MAX_EXCERPT),recordKind:text.kind,source:text.source,
        history:{sessionId,agentId:'main',turn:text.turnId}});
    }else if(item.kind==='turn')for(const step of item.steps)for(const frame of step.frames){
      if(frame.kind!=='tool')continue;
      const output=previewOutput(frame.output);
      items.push({id:`tool:${item.ordinal}:${frame.toolCallId}`,kind:'tool_record',title:frame.name,toolName:frame.name,excerpt:output.slice(0,MAX_EXCERPT),source,
        history:{sessionId,agentId:'main',turn:item.ordinal}});
    }
  }
  const complete=scan.complete&&items.length<=MAX_ITEMS;
  return {state:complete?'complete':'partial',sessionId,items:items.slice(-MAX_ITEMS),knownTotal:scan.complete?items.length:undefined,
    coverage:{complete,bytesRead:scan.bytesRead,recordsRead:scan.recordsRead,reason:scan.incompleteReason??(items.length>MAX_ITEMS?'item_limit':undefined)}};
}

function previewOutput(output:unknown):string {
  if(typeof output==='string')return output.slice(0,MAX_EXCERPT);
  if(!Array.isArray(output))return '';
  let text='';
  for(const part of output as unknown[]){
    if(part===null||typeof part!=='object'||!('text' in part)||typeof part.text!=='string')continue;
    text+=`${text?'\n':''}${part.text.slice(0,MAX_EXCERPT-text.length)}`;
    if(text.length>=MAX_EXCERPT)break;
  }
  return text;
}
