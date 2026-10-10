/**
 * The external-client wire types, defining the client and listener models
 * for external access to Kiki.
 */

export interface ExternalClientConnection {
  readonly id: string;
  readonly name: string;
  readonly workspace?: string;
  readonly mode: 'manual' | 'auto' | 'review' | 'yolo';
  readonly tools: string[];
  readonly allowCommands: boolean;
  readonly memoryScopes: ('workspace' | 'global' | 'persona' | 'persona_workspace')[];
  readonly historyScope: 'current' | 'connection' | 'workspace';
  readonly status: 'active' | 'paused' | 'revoked';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExternalClientConnectionInput {
  readonly name: string;
  readonly workspace?: string;
  readonly mode?: ExternalClientConnection['mode'];
  readonly tools?: string[];
  readonly allowCommands?: boolean;
  readonly memoryScopes?: ExternalClientConnection['memoryScopes'];
  readonly historyScope?: ExternalClientConnection['historyScope'];
}

export interface ExternalClientSession {
  readonly sessionId: string;
  readonly sessionRef: string;
  readonly connectionId: string;
  readonly clientName: string;
  readonly workspace: string;
  readonly status: 'open' | 'closed';
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExternalClientListener {
  readonly enabled: boolean;
  readonly state: 'stopped' | 'listening' | 'error';
  readonly origin?: string;
  readonly mcpUrl?: string;
  readonly publicUrl?: string;
  readonly discovery?: 'unchecked' | 'reachable' | 'failed';
  readonly error?: string;
}

export interface ExternalClientListenerInput {
  readonly enabled: boolean;
  readonly port?: number;
  readonly host?: string;
  readonly publicUrl?: string;
}

export interface ExternalClientAuthorization {
  readonly id: string;
  readonly clientId: string;
  readonly clientName?: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
}

export interface ExternalClientTextInput {
  readonly text: string;
  readonly kind: 'note' | 'user_excerpt' | 'assistant_excerpt' | 'handoff';
  readonly title?: string;
  readonly idempotencyKey: string;
  readonly relatedOperationIds?: string[];
}

export interface ExternalClientTextReceipt {
  readonly recordId: string;
  readonly sessionRef: string;
  readonly savedAt: number;
  readonly duplicate: boolean;
  readonly historyRef?: string;
}

export interface ExternalClientMaterial {
  readonly id: string;
  readonly kind: 'saved_text' | 'tool_record';
  readonly title: string;
  readonly excerpt: string;
  readonly source: {
    readonly connectionId: string;
    readonly clientName: string;
    readonly sessionRef: string;
    readonly driver: 'external';
  };
  readonly recordKind?: ExternalClientTextInput['kind'];
  readonly toolName?: string;
  readonly history: {
    readonly sessionId: string;
    readonly agentId: 'main';
    readonly turn: number;
  };
}

export interface ExternalClientMaterialsPreview {
  readonly state: 'complete' | 'partial' | 'unloaded';
  readonly sessionId: string;
  readonly items: readonly ExternalClientMaterial[];
  readonly knownTotal?: number;
  readonly coverage: {
    readonly complete: boolean;
    readonly bytesRead: number;
    readonly recordsRead: number;
    readonly reason?: string;
  };
}

export interface ExternalClientsFacade {
  list(options?: unknown): Promise<{ connections: ExternalClientConnection[]; listener: ExternalClientListener }>;
  create(body: ExternalClientConnectionInput, options?: unknown): Promise<{ connection: ExternalClientConnection; stdio: { command: string; args: string[] } }>;
  update(id: string, body: Partial<ExternalClientConnectionInput> & { enabled?: boolean }, options?: unknown): Promise<{ connection: ExternalClientConnection }>;
  revoke(id: string, options?: unknown): Promise<{ connection: ExternalClientConnection }>;
  sessions(id: string, options?: unknown): Promise<{ sessions: ExternalClientSession[] }>;
  stdio(id: string, options?: unknown): Promise<{ command: string; args: string[] }>;
  listener(options?: unknown): Promise<ExternalClientListener>;
  configureListener(body: ExternalClientListenerInput, options?: unknown): Promise<ExternalClientListener>;
  authorizations(options?: unknown): Promise<{ authorizations: ExternalClientAuthorization[] }>;
  respondAuthorization(id: string, body: { connectionId: string; approved: boolean }, options?: unknown): Promise<{ approved: boolean }>;
  saveText(sessionId: string, body: ExternalClientTextInput, options?: unknown): Promise<ExternalClientTextReceipt>;
  materials(sessionId: string, options?: unknown): Promise<ExternalClientMaterialsPreview>;
  continue(sessionId: string, body?: { title?: string }, options?: unknown): Promise<{ sessionId: string }>;
  closeSession(sessionId: string, options?: unknown): Promise<{ session: ExternalClientSession }>;
  stopSession(sessionId: string, options?: unknown): Promise<{ session: ExternalClientSession }>;
}

/** The native permission mode a connection's calls run under. */
export type ExternalConnectionMode = ExternalClientConnection['mode'];

/** What a create or update may change; omitted fields keep their value. */
export type ExternalConnectionPatch = Partial<ExternalClientConnectionInput> & { enabled?: boolean };

/** Which memory scopes a connection may read and write. */
export type ExternalMemoryScope = NonNullable<ExternalClientConnectionInput['memoryScopes']>[number];

/** How much of the past a connection may read. */
export type ExternalHistoryScope = NonNullable<ExternalClientConnectionInput['historyScope']>;

/** What kind of text a client is saving; the kind is the client's claim, not Kiki's. */
export type ExternalTextKind = NonNullable<ExternalClientTextInput['kind']>;
