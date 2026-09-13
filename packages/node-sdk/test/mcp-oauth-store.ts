/**
 * A file-backed `McpOAuthService` over a bare home directory, for tests that
 * seed or inspect MCP OAuth credentials outside a running SDK client. Mirrors
 * the engine's App-scope wiring: JSON documents under `<homeDir>/credentials/mcp`.
 */
import { createMcpOAuthStore } from '@kiki/agent-core-v2/app/mcpConfig/oauthStore';
import { McpOAuthService } from '@kiki/agent-core-v2/mcpCore/oauth/service';
import { JsonAtomicDocumentStore } from '@kiki/agent-core-v2/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '@kiki/agent-core-v2/persistence/backends/node-fs/fileStorageService';

export function createFileMcpOAuthService(homeDir: string): McpOAuthService {
  const storage = new FileStorageService(homeDir, 0o700, 0o600);
  return new McpOAuthService({ store: createMcpOAuthStore(new JsonAtomicDocumentStore(storage)) });
}
