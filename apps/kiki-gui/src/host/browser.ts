import type { HostAdapter } from './host';

interface ViteLocalServerPayload {
  readonly url?: string;
  readonly token?: string;
  readonly error?: string;
}

export const browserHost: HostAdapter = {
  kind: 'browser',
  connection: {
    async discover() {
      const response = await fetch('/__kiki/local-server');
      if (!response.ok) throw new Error(`Local server detection failed (${response.status})`);
      const payload = (await response.json()) as ViteLocalServerPayload;
      if (payload.error !== undefined) throw new Error(payload.error);
      if (payload.url === undefined) return null;
      return {
        config: { url: payload.url, token: payload.token ?? '' },
        persist: true,
      };
    },
  },
};
