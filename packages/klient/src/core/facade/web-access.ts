import type { WebAccessEnableInput, WebAccessExchangeInput, WebAccessLink, WebAccessSession, WebAccessStatus } from '@kiki/protocol';

export interface WebAccessFacade {
  status(): Promise<WebAccessStatus>;
  enable(input: WebAccessEnableInput): Promise<WebAccessStatus>;
  disable(): Promise<WebAccessStatus>;
  issueLink(): Promise<WebAccessLink>;
  revoke(sessionId?: string): Promise<WebAccessStatus>;
  current(): Promise<WebAccessSession>;
  exchange(input: WebAccessExchangeInput): Promise<WebAccessSession>;
  logout(): Promise<WebAccessSession>;
}
