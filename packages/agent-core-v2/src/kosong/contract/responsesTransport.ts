export interface ResponsesWebSocketConfig {
  targets: string[];
}

export interface ResponsesOutputProjection {
  readonly input: readonly unknown[];
  readonly incremental: boolean;
}

export interface ResponsesRequestTransport {
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
