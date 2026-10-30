export interface ResponsesWebSocketConfig {
  targets: string[];
}

export interface ResponsesOutputProjection {
  readonly input: readonly unknown[];
  readonly incremental: boolean;
}

export interface ResponsesTransportDiagnostics {
  readonly transport: 'ws' | 'sse';
  readonly webSocketCapabilities: boolean | null;
  readonly webSocketCapabilityVersion: 1 | 2 | null;
  readonly webSocketConnectionAgeMs: number | null;
}

export interface ResponsesRequestTransport {
  diagnostics?(): ResponsesTransportDiagnostics;
  request(params: Record<string, unknown>, options: {
    baseUrl: string;
    apiKey: string;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    canonicalOutput?: (nativeOutput: readonly unknown[]) => ResponsesOutputProjection | undefined;
    onFullInput?: (input: readonly unknown[]) => void;
  }): Promise<AsyncIterable<unknown>>;
  commitResponse(responseId: string, canonicalOutput: readonly unknown[]): void;
  close(): void;
}
