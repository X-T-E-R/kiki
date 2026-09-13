import type { CloseTerminalResponse, CreateTerminalRequest, GetTerminalResponse, ListTerminalsResponse, Terminal } from '@kiki/protocol';

export type TerminalConnectionStatus = 'connecting' | 'open' | 'closed';
export interface TerminalAttachResult {
  readonly replayed: number;
  readonly earliestSeq: number | null;
  readonly truncated: boolean;
}
export type TerminalSignal =
  | ({ readonly kind: 'attached'; readonly sessionId: string; readonly terminalId: string } & TerminalAttachResult)
  | { readonly kind: 'output'; readonly sessionId: string; readonly terminalId: string; readonly seq: number; readonly data: string }
  | { readonly kind: 'exit'; readonly sessionId: string; readonly terminalId: string; readonly exitCode: number | null }
  | { readonly kind: 'unavailable'; readonly sessionId: string; readonly terminalId: string };

/** HTTP-only PTY capability, using the same connection as events and session views. */
export interface TerminalFacade {
  listTerminals(sessionId: string): Promise<ListTerminalsResponse>;
  createTerminal(sessionId: string, body?: CreateTerminalRequest): Promise<Terminal>;
  getTerminal(sessionId: string, terminalId: string): Promise<GetTerminalResponse>;
  closeTerminal(sessionId: string, terminalId: string): Promise<CloseTerminalResponse>;
  terminalAttach(sessionId: string, terminalId: string): Promise<TerminalAttachResult>;
  terminalDetach(sessionId: string, terminalId: string): void;
  terminalInput(sessionId: string, terminalId: string, data: string): void;
  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void;
  onTerminalSignal(listener: (signal: TerminalSignal) => void): () => void;
  onStatus(listener: (status: TerminalConnectionStatus) => void): () => void;
  nudge(): void;
}

export function createTerminalFacade(channel: TerminalFacade | undefined): TerminalFacade {
  if (channel !== undefined) return channel;
  const unsupported = (): never => { throw new Error('terminal capability is unsupported on this transport'); };
  const rejected = async (): Promise<never> => unsupported();
  return {
    listTerminals: rejected, createTerminal: rejected, getTerminal: rejected, closeTerminal: rejected,
    terminalAttach: rejected, terminalDetach: unsupported, terminalInput: unsupported,
    terminalResize: unsupported, onTerminalSignal: unsupported, onStatus: unsupported, nudge: unsupported,
  };
}
