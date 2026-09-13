import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConfigTarget,
  IConfigService,
  ISessionIndex,
} from '@kiki/agent-core-v2';
import { vi } from 'vitest';

import { startServer } from '../../kap-server/src/start.js';
import { createKlient } from '../src/transports/http/index.js';
import { defineKlientConformance } from './helpers/conformance.js';
import { TEST_CLIENT_IDENTITY } from './helpers/engine.js';

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

defineKlientConformance('http', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'klient-conformance-http-'));
  const server = await startServer({
    hostIdentity: TEST_CLIENT_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir,
    logLevel: 'silent',
  });
  await server.core.accessor
    .get(IConfigService)
    .replace('threadCommunication', { enabled: true }, ConfigTarget.Memory);
  await server.core.accessor.get(ISessionIndex).prepare();
  const klient = createKlient({
    endpoint: `http://127.0.0.1:${server.port}`,
    token: server.authTokenService.getToken(),
  });
  return {
    klient,
    app: server.core,
    cleanup: async () => {
      await klient.close();
      await server.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    },
  };
});
