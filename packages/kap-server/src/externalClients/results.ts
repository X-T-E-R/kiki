import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '@kiki/agent-core-v2/tool/toolContract';
import type { ContentPart } from '@kiki/agent-core-v2/kosong/contract/message';
import type { ExternalClientOperation } from './contracts';
const MCP_TEXT_BUDGET=24_000;
const MCP_MEDIA_BYTES=2<<20;
export function operationReceipt(operation:ExternalClientOperation,duplicate:boolean):CallToolResult {
  const result=operation.result as ToolResult|undefined;
  const structured={operation_id:operation.id,operationId:operation.id,session_ref:operation.sessionRef,state:operation.state,duplicate,
    result:result===undefined?undefined:boundedResult(result),error:operation.error,
    poll:{tool:'kiki_operation',arguments:{operation_id:operation.id}},full_result:{tool:'kiki_operation',arguments:{operation_id:operation.id,action:'read'}},history:{tool:'HistoryList',arguments:{_kiki:{session_ref:operation.sessionRef}}}};
  const content:CallToolResult['content']=[{type:'text',text:JSON.stringify(structured)}];
  if(result?.output!==undefined&&Array.isArray(result.output))for(const part of result.output) appendMedia(content,part);
  return {content,structuredContent:structured,isError:operation.state==='failed'||operation.state==='cancelled'||result?.isError===true};
}
function boundedResult(result:ToolResult):unknown {
  if(typeof result.output==='string')return {...result,output:result.output.slice(0,MCP_TEXT_BUDGET),mcp_truncated:result.output.length>MCP_TEXT_BUDGET};
  if(Array.isArray(result.output))return {...result,output:result.output.map(part=>part.type==='text'?{type:'text',text:part.text.slice(0,MCP_TEXT_BUDGET),mcp_truncated:part.text.length>MCP_TEXT_BUDGET}:mediaSummary(part))};
  return result;
}
function mediaSummary(part:ContentPart):unknown {
  if(part.type==='think')return {type:'unavailable',reason:'Internal thought content is not a media result.'};
  if(part.type==='text')return part;
  const url=part.type==='image_url'?part.imageUrl.url:part.type==='audio_url'?part.audioUrl.url:part.videoUrl.url;
  const mime=/^data:([^;,]+)/.exec(url)?.[1];
  return {type:part.type,mime,delivery:url.startsWith('data:')?'saved_media':'artifact',reference:url.startsWith('data:')?undefined:url};
}
function appendMedia(content:CallToolResult['content'],part:ContentPart):void {
  if(part.type==='text'||part.type==='think')return;
  const url=part.type==='image_url'?part.imageUrl.url:part.type==='audio_url'?part.audioUrl.url:part.videoUrl.url;
  const match=/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if(match!==null&&Buffer.byteLength(match[2]!,'base64')<=MCP_MEDIA_BYTES){
    if(part.type==='image_url')content.push({type:'image',mimeType:match[1]!,data:match[2]!});
    else if(part.type==='audio_url')content.push({type:'audio',mimeType:match[1]!,data:match[2]!});
    else content.push({type:'resource',resource:{uri:'kiki:saved-video',mimeType:match[1]!,blob:match[2]!}});
  }else content.push({type:'text',text:'Saved media exceeds this MCP response budget or uses an artifact reference. Use kiki_operation with action=read and the output part index, then follow next until complete. Historical bytes come from the saved result, not the current host file.'});
}
