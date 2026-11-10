import { FIXTURE_TOKEN } from './fixture-server.mjs';

const HERO = '[data-phase="hero"]';
const COMPOSER_READY = '[data-composer-input][contenteditable="true"]:not([aria-disabled="true"])';

async function showTheme({ page, view, serverUrl, waitFor, scroll }) {
  const headers = { authorization: `Bearer ${FIXTURE_TOKEN}` };
  const request = async (path, data) => {
    const url = new URL(`/api${path}`, serverUrl).href;
    const response = data === undefined
      ? await page.request.get(url, { headers })
      : await page.request.post(url, { headers, data });
    const body = await response.json();
    if (!response.ok() || body.code !== 0) throw new Error(`Theme fixture failed at ${path}: ${body.msg}`);
    return body.data;
  };
  const meta = await request('/meta');
  if (!meta.current_space_id) throw new Error('Theme fixture has no space identity');
  const settings = `/homes/${encodeURIComponent(meta.current_space_id)}/settings`;
  const preview = await request(`${settings}/preview`, { action: 'edit', changes: [{ id: 'pref:theme', value: view.theme }] });
  await request(`${settings}/apply`, { token: preview.token, selected: ['pref:theme'] });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(`html[data-theme="${view.theme}"] ${HERO}`, { timeout: 15_000 });
  await waitFor(COMPOSER_READY, { timeout: 15_000 });
  await scroll('top');
}

export default {
  name: 'headless-smoke',
  scenario: 'hero-shell',
  vite: true,
  routes: [
    {
      name: 'hero-shell',
      path: '/new',
      waitFor: [HERO, COMPOSER_READY],
      setup: showTheme,
    },
  ],
  matrix: {
    themes: ['light', 'dark'],
    locales: ['en', 'zh'],
    viewports: ['wide', 'narrow'],
  },
};
