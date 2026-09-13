import { startFixtureServer, FIXTURE_TOKEN } from './fixture-server.mjs';

async function test() {
  const fixture = await startFixtureServer({ port: 0, scenario: 'gui-slice' });
  const originalUpgrade = fixture.handleUpgrade.bind(fixture);
  fixture.handleUpgrade = (req, socket, head) => {
    console.log('UPGRADE REQUEST URL:', req.url);
    console.log('UPGRADE HEADERS:', req.headers);
    return originalUpgrade(req, socket, head);
  };
}
test();
