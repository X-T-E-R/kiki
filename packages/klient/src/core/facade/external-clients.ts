import type { HttpRestRequestOptions } from './http-rest.js';
export interface ExternalClientConnection {
  readonly id: string; readonly name: string; readonly workspace?: string;
  readonly mode: 'manual'|'auto'|'review'|'yolo'; readonly tools: string[]; readonly allowCommands: boolean;
  readonly memoryScopes: ('workspace'|'global'|'persona'|'persona_workspace')[];
  readonly historyScope: 'current'|'connection'|'workspace'; readonly status: 'active'|'paused'|'revoked';
  readonly createdAt: number; readonly updatedAt: number;
}
export interface ExternalClientConnectionInput {
  readonly name: string; readonly workspace?: string; readonly mode?: ExternalClientConnection['mode'];
  readonly tools?: string[]; readonly allowCommands?: boolean; readonly memoryScopes?: ExternalClientConnection['memoryScopes'];
  readonly historyScope?: ExternalClientConnection['historyScope'];
}
export interface ExternalClientSession {
  readonly sessionId: string; readonly sessionRef: string; readonly connectionId: string; readonly clientName: string;
  readonly workspace: string; readonly permissionMode?: ExternalClientConnection['mode'];
  readonly status:'open'|'closed'; readonly createdAt:number; readonly updatedAt:number;
}
export interface ExternalClientListener {
  readonly enabled:boolean; readonly state:'stopped'|'listening'|'error'; readonly origin?:string; readonly mcpUrl?:string;
  readonly publicUrl?:string; readonly discovery?:'unchecked'|'reachable'|'failed'; readonly error?:string;
}
export interface ExternalClientListenerInput {readonly enabled:boolean;readonly port?:number;readonly host?:string;readonly publicUrl?:string;}
export interface ExternalClientAuthorization { readonly id:string;readonly clientId:string;readonly clientName?:string;readonly redirectUri:string;readonly scopes:readonly string[];readonly createdAt:number; }
export interface ExternalClientTextInput { readonly text:string;readonly kind:'note'|'user_excerpt'|'assistant_excerpt'|'handoff';readonly title?:string;readonly idempotencyKey:string;readonly relatedOperationIds?:string[]; }
export interface ExternalClientTextReceipt { readonly recordId:string;readonly sessionRef:string;readonly savedAt:number;readonly duplicate:boolean;readonly historyRef?:string; }
export interface ExternalClientMaterial {
  readonly id:string;readonly kind:'saved_text'|'tool_record';readonly title:string;readonly excerpt:string;
  readonly source:{readonly connectionId:string;readonly clientName:string;readonly sessionRef:string;readonly driver:'external'};
  readonly recordKind?:ExternalClientTextInput['kind'];readonly toolName?:string;
  readonly history:{readonly sessionId:string;readonly agentId:'main';readonly turn:number};
}
export interface ExternalClientMaterialsPreview {
  readonly state:'complete'|'partial'|'unloaded';readonly sessionId:string;readonly items:readonly ExternalClientMaterial[];
  readonly knownTotal?:number;
  readonly coverage:{readonly complete:boolean;readonly bytesRead:number;readonly recordsRead:number;readonly reason?:string};
}
export interface ExternalClientsFacade {
  list(options?:HttpRestRequestOptions):Promise<{connections:ExternalClientConnection[];listener:ExternalClientListener}>;
  create(body:ExternalClientConnectionInput,options?:HttpRestRequestOptions):Promise<{connection:ExternalClientConnection;stdio:{command:string;args:string[]}}>;
  update(id:string,body:Partial<ExternalClientConnectionInput>&{enabled?:boolean},options?:HttpRestRequestOptions):Promise<{connection:ExternalClientConnection}>;
  revoke(id:string,options?:HttpRestRequestOptions):Promise<{connection:ExternalClientConnection}>;
  sessions(id:string,options?:HttpRestRequestOptions):Promise<{sessions:ExternalClientSession[]}>;
  stdio(id:string,options?:HttpRestRequestOptions):Promise<{command:string;args:string[]}>;
  listener(options?:HttpRestRequestOptions):Promise<ExternalClientListener>;
  configureListener(body:ExternalClientListenerInput,options?:HttpRestRequestOptions):Promise<ExternalClientListener>;
  authorizations(options?:HttpRestRequestOptions):Promise<{authorizations:ExternalClientAuthorization[]}>;
  respondAuthorization(id:string,body:{connectionId:string;approved:boolean},options?:HttpRestRequestOptions):Promise<{approved:boolean}>;
  saveText(sessionId:string,body:ExternalClientTextInput,options?:HttpRestRequestOptions):Promise<ExternalClientTextReceipt>;
  materials(sessionId:string,options?:HttpRestRequestOptions):Promise<ExternalClientMaterialsPreview>;
  continue(sessionId:string,body?:{title?:string},options?:HttpRestRequestOptions):Promise<{sessionId:string}>;
  closeSession(sessionId:string,options?:HttpRestRequestOptions):Promise<{session:ExternalClientSession}>;
  stopSession(sessionId:string,options?:HttpRestRequestOptions):Promise<{session:ExternalClientSession}>;
}
