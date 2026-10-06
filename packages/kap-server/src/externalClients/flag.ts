import { registerFlagDefinition } from '@kiki/agent-core-v2/app/flag/flagRegistry';
export const EXTERNAL_CLIENT_FLAG_ID = 'external_clients';
registerFlagDefinition({id:EXTERNAL_CLIENT_FLAG_ID,title:'External clients',description:'Let explicitly authorized MCP clients drive ordinary Kiki sessions using native tools.',
  env:'KIKI_EXPERIMENTAL_EXTERNAL_CLIENTS',default:false,surface:'core'});
