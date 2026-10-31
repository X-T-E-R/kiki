import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mediaGenerateInputSchema, mediaActionSchema } from '@kiki/protocol';
import { z } from 'zod';
import { IFileService, ISessionManager, ISessionInteractionService } from '@kiki/agent-core-v2';
import { Readable } from 'node:stream';
import { ExternalClientStore } from '../src/externalClients/store';
import { ISessionApprovalService } from '@kiki/agent-core-v2/session/approval/approval';

import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const generate='plugin__fixture_media__generate';
const media='plugin__fixture_media__media';
let root:string;
let home:string;
let workspace:string;
let server:RunningServer;
let base:string;
let token:string;
let connectionId:string;
let ref:string;

beforeEach(async()=>{
  vi.stubEnv('KIKI_EXPERIMENTAL_EXTERNAL_CLIENTS','true');
  vi.stubEnv('KIKI_SEARCH_DISABLED','1');
  root=await mkdtemp(join(tmpdir(),'kiki-script-tools-'));
  home=join(root,'home');workspace=join(root,'work');
  await mkdir(workspace,{recursive:true});
  server=await startServer({hostIdentity:TEST_HOST_IDENTITY,homeDir:home,host:'127.0.0.1',port:0,logLevel:'silent'});
  base=`http://127.0.0.1:${server.port}`;
});
afterEach(async()=>{await server?.close();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
async function owner(path:string,body?:unknown,method='POST'):Promise<any>{
  const response=await authedFetch(server,base,path,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();expect(result.code,result.msg).toBe(0);return result.data;
}
async function setup(tools=['Read','Write']){
  const created=await owner('/api/external-clients',{name:'Script fixture',workspace,mode:'yolo',tools,allowCommands:tools.includes(generate)});
  connectionId=created.connection.id;
  token=(await owner(`/api/external-clients/${connectionId}/credential`,{})).token;
  const selected=await request('/tools/kiki_session:call',{arguments:{action:'new'},idempotency_key:'session-fixture'});
  expect(selected.code,selected.msg).toBe(0);ref=selected.data.structuredContent.session_ref;
}
async function request(path:string,body?:unknown,bearer=token):Promise<any>{
  const response=await fetch(`${base}/api/external-clients${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,...await response.json() as object};
}
async function call(name:string,args:Record<string,unknown>,session=ref,key?:string):Promise<any>{
  const result=await request(`/tools/${encodeURIComponent(name)}:call`,{arguments:args,session_ref:session,idempotency_key:key});
  expect(result.code,result.msg).toBe(0);return result.data.structuredContent;
}
async function terminal(receipt:any):Promise<any>{
  let value=receipt;
  await vi.waitFor(async()=>{
    value=(await request(`/jobs/${receipt.operation_id}`)).data.structuredContent;
    expect(['accepted','running','waiting_approval']).not.toContain(value.state);
  },{timeout:15_000,interval:20});
  return value;
}
async function installMedia(){
  const source=join(root,'plugin');
  await cp(fileURLToPath(new URL('../../agent-core-v2/test/fixtures/plugin-media',import.meta.url)),source,{recursive:true});
  const entry=await readFile(join(source,'entry.mjs'),'utf8');
  const tools=[
    {schemaVersion:1,name:'generate',description:'Fixture generation',mediaInputs:true,parameters:z.toJSONSchema(mediaGenerateInputSchema,{io:'input'}),accesses:[{kind:'all'}]},
    {schemaVersion:1,name:'media',description:'Fixture job lookup and resume',parameters:z.toJSONSchema(mediaActionSchema,{io:'input'}),accesses:[{kind:'all'}]},
  ];
  await writeFile(join(source,'entry.mjs'),`${entry.replace('export function register(api)','function registerProvider(api)')}
export function register(api) {
  registerProvider(api);
  const tools=${JSON.stringify(tools)};
  for(const definition of tools) api.registerTool(definition,async(input,context)=>{
    const job=definition.name==='generate'?await context.media.generate(input):await context.media.media(input);
    return {output:JSON.stringify({type:'media_generation',job}),isError:['failed','unknown'].includes(job.state)};
  });
}
`);
  const manifest=JSON.parse(await readFile(join(source,'kimi.plugin.json'),'utf8'));
  manifest['x-kiki'].tools=tools;
  await writeFile(join(source,'kimi.plugin.json'),JSON.stringify(manifest));
  const preview=await owner('/api/plugins:preview',{source});
  await owner('/api/plugins',{source,fingerprint:preview.fingerprint,consent:true,defaultEnabled:true});
  await owner('/api/plugins/fixture-media/settings',{values:{remoteDir:root,apiKey:'fixture-only-key'}});
}
async function jobFrom(receipt:any):Promise<any>{const completed=await terminal(receipt);expect(completed.result.isError,JSON.stringify(completed)).not.toBe(true);return JSON.parse(completed.result.output).job;}
async function submitted(){return (await readFile(join(root,'submitted.log'),'utf8')).trim().split('\n');}

describe('script tool access',()=>{
  it('uses only the connection credential, enforces catalog grants and rejects revoked connections',async()=>{
    await setup(['Read']);
    expect((await request('/tools')).data.tools.map((tool:any)=>tool.name)).toContain('Read');
    expect(await request('/tools/Write:call',{arguments:{path:join(workspace,'denied.txt'),content:'never'},session_ref:ref,idempotency_key:'denied'})).toMatchObject({code:40001,details:{code:'tool_unavailable'}});
    const ownerTokenResponse=await authedFetch(server,base,'/api/external-clients/tools');expect(ownerTokenResponse.status).toBe(401);
    expect((await fetch(`${base}/api/config`,{headers:{authorization:`Bearer ${token}`}})).status).toBe(401);
    const remote=await server.app.inject({method:'GET',url:'/api/external-clients/tools',headers:{authorization:`Bearer ${token}`},remoteAddress:'192.0.2.10'});
    expect(remote.statusCode).toBe(403);
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+3600_001);
    try {expect((await request('/tools')).status).toBe(401);} finally {clock.mockRestore();}
    await owner(`/api/external-clients/${connectionId}`,undefined,'DELETE');
    expect((await request('/tools')).status).toBe(401);
  });
  it('deduplicates concurrent submissions, rejects changed arguments and reads saved results',async()=>{
    await setup();
    const args={path:join(workspace,'once.txt'),content:'once'};
    const [left,right]=await Promise.all([call('Write',args,ref,'write-once'),call('Write',args,ref,'write-once')]);
    expect(left.operation_id).toBe(right.operation_id);expect([left.duplicate,right.duplicate].filter(Boolean)).toHaveLength(1);
    expect((await terminal(left)).state).toBe('completed');expect(await readFile(args.path,'utf8')).toBe('once');
    expect(await request('/tools/Write:call',{arguments:{...args,content:'changed'},session_ref:ref,idempotency_key:'write-once'})).toMatchObject({code:40001,details:{code:'idempotency_conflict'}});
    const page=await request(`/jobs/${left.operation_id}/result?limit=5`);expect(page.data.structuredContent).toMatchObject({complete:false,range:{start:0,end:5,unit:'utf16'}});
    const readArgs={path:args.path};
    expect((await terminal(await call('Read',readArgs))).result.output).toContain('once');
    await writeFile(args.path,'fresh');
    expect((await terminal(await call('Read',readArgs))).result.output).toContain('fresh');
    const other=await owner('/api/external-clients',{name:'Other script',workspace,mode:'yolo'});
    const otherToken=(await owner(`/api/external-clients/${other.connection.id}/credential`,{})).token;
    expect(await request(`/jobs/${left.operation_id}`,undefined,otherToken)).toMatchObject({code:40001,details:{code:'operation_unavailable'}});
  });
  it('returns a background media job, resumes download and pages original bytes without another purchase',async()=>{
    await installMedia();await setup([generate,media]);
    const args={request_id:'fixture-video',provider:'fixture-media/synthetic',execution:'background',request:{kind:'video',prompt:'download'}};
    const receipt=await call(generate,args,ref,'generate-video');const job=await jobFrom(receipt);
    expect(job.job_id).toMatch(/^media-/);expect(['running','pending']).toContain(job.state);
    await vi.waitFor(async()=>{expect(await submitted()).toHaveLength(1);});
    expect((await call(generate,args,ref,'generate-video')).operation_id).toBe(receipt.operation_id);
    await writeFile(join(root,'ready'),'fail');
    await vi.waitFor(async()=>{const current=await jobFrom(await call(media,{action:'get',job_id:job.job_id},ref,`read-${Date.now()}`));expect(current.phase).toBe('download');},{timeout:15_000});
    await writeFile(join(root,'ready'),'ready');
    await call(media,{action:'resume',job_id:job.job_id},ref,'resume-video');
    let final:any;
    await vi.waitFor(async()=>{final=await terminal(await call(media,{action:'get',job_id:job.job_id},ref,`final-${Date.now()}`));expect(JSON.parse(final.result.output).job.state,final.result.output).toBe('succeeded');},{timeout:15_000});
    const chunks:Buffer[]=[];let offset=0;
    while(true){const page=(await request(`/jobs/${final.operation_id}/result?artifact=0&offset=${offset}&limit=5`)).data;
      chunks.push(Buffer.from(page.content.find((part:any)=>part.type==='resource').resource.blob,'base64'));
      if(page.structuredContent.complete)break;offset=page.structuredContent.range.end;}
    expect(Buffer.concat(chunks).toString()).toBe('media-original-bytes');expect(await submitted()).toHaveLength(1);
    const staged=await server.core.accessor.get(IFileService).save(Readable.from(['private staged bytes']),'private.bin');
    const store=new ExternalClientStore(server.core);
    const saved=(await store.operation(final.operation_id))!;
    await store.saveOperation({...saved,result:{output:JSON.stringify({type:'media_generation',job:{artifacts:[{file_id:staged.id}]}})}});
    expect(await request(`/jobs/${final.operation_id}/result?artifact=0`)).toMatchObject({code:40001,details:{code:'artifact_unavailable'}});
  },60_000);
  it('preserves unknown media submission across an identical retry without buying again',async()=>{
    await installMedia();await setup([generate,media]);
    const args={request_id:'fixture-unknown',provider:'fixture-media/synthetic',execution:'background',request:{kind:'image',prompt:'unknown'}};
    const receipt=await call(generate,args,ref,'unknown-once');const initial=await jobFrom(receipt);
    await vi.waitFor(async()=>{const observed=await terminal(await call(media,{action:'get',job_id:initial.job_id},ref,`unknown-${Date.now()}`));expect(JSON.parse(observed.result.output).job).toMatchObject({state:'unknown',can_resume:false});},{timeout:15_000});
    const duplicate=await call(generate,args,ref,'unknown-once');expect(duplicate).toMatchObject({duplicate:true,operation_id:receipt.operation_id});expect(await submitted()).toHaveLength(1);
  },60_000);
  it('uses native approvals and honors a session plugin off choice',async()=>{
    await setup();
    await owner(`/api/external-clients/${connectionId}`,{mode:'manual'},'PATCH');
    const sessions=await owner(`/api/external-clients/${connectionId}/sessions`,undefined,'GET');
    const sessionId=sessions.sessions[0].sessionId;
    const session=server.core.accessor.get(ISessionManager).get(sessionId)!;
    const interaction=session.accessor.get(ISessionInteractionService);
    interaction.acquireConsumer('script-fixture');
    const pending=await call('Write',{path:join(workspace,'approved.txt'),content:'approved'},ref,'approve-write');
    await vi.waitFor(async()=>{expect((await request(`/jobs/${pending.operation_id}`)).data.structuredContent.state).toBe('waiting_approval');});
    const approval=interaction.listPending('approval')[0]!;
    session.accessor.get(ISessionApprovalService).decide(approval.id,{decision:'approved'});
    expect((await terminal(pending)).result.isError).not.toBe(true);
    expect(await readFile(join(workspace,'approved.txt'),'utf8')).toBe('approved');
    await installMedia();
    await owner('/api/plugins/usage',{target:{session_id:sessionId},plugin_id:'fixture-media',override:'off'});
    await owner(`/api/external-clients/${connectionId}`,{mode:'yolo',tools:[generate,media],allowCommands:true},'PATCH');
    const denied=await request(`/tools/${generate}:call`,{arguments:{request_id:'disabled-plugin',provider:'fixture-media/synthetic',execution:'background',request:{kind:'image',prompt:'sync'}},session_ref:ref,idempotency_key:'disabled-plugin'});
    expect(denied).toMatchObject({code:40001,details:{code:'tool_unavailable'}});
    await expect(readFile(join(root,'submitted.log'))).rejects.toThrow();
  },60_000);
  it('runs the actual JSON CLI to list, call, query and download a saved result',async()=>{
    await setup();
    const credentialFile=join(root,'credential');await writeFile(credentialFile,token);
    const require=createRequire(import.meta.url);
    const cli=fileURLToPath(new URL('../../../apps/kimi-code/src/main.ts',import.meta.url));
    const loader=new URL('../../../build/register-raw-text-loader.mjs',import.meta.url).href;
    const invoke=async(args:string[])=>{
      const result=await promisify(execFile)(process.execPath,['--import',pathToFileURL(require.resolve('tsx/esm')).href,'--import',loader,cli,'tools','--url',base,'--credential-file',credentialFile,...args],{cwd:workspace,env:{...process.env,TSX_TSCONFIG_PATH:fileURLToPath(new URL('../../../apps/kimi-code/tsconfig.dev.json',import.meta.url))},timeout:30_000});
      expect(result.stdout).not.toContain(token);return JSON.parse(result.stdout.trim());
    };
    expect((await invoke(['list'])).tools.map((tool:any)=>tool.name)).toContain('Read');
    await writeFile(join(workspace,'source.txt'),'CLI original');
    const called=await invoke(['call','Read','--session-ref',ref,'--args',JSON.stringify({path:join(workspace,'source.txt')})]);
    const receipt=await terminal(called.structuredContent);
    expect((await invoke(['job','get',receipt.operation_id])).structuredContent.state).toBe('completed');
    const output=join(root,'result.json');expect(await invoke(['job','download',receipt.operation_id,'--output',output])).toMatchObject({operation_id:receipt.operation_id,output});
    expect(await readFile(output,'utf8')).toContain('CLI original');
  },90_000);
});
