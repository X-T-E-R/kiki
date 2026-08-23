import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareSemver,
  generateUpdaterFeeds,
  parseSemver,
  selectFeedReleases,
} from './desktop-release-feed.mjs';

function release(version, { prerelease = version.includes('-'), draft = false } = {}) {
  return {
    tag_name: `kiki-v${version}`,
    draft,
    prerelease,
    published_at: '2026-03-22T10:00:00Z',
    assets: [{
      name: 'latest.json',
      browser_download_url: `https://example.test/${version}/latest.json`,
    }],
  };
}

function manifest(version) {
  return {
    version,
    notes: '',
    pub_date: '2026-03-22T10:00:00.000Z',
    platforms: {
      'windows-x86_64': {
        signature: `signature-${version}`,
        url: `https://example.test/${version}/installer.exe`,
      },
    },
  };
}

test('compares stable and beta semantic versions', () => {
  assert.equal(compareSemver(parseSemver('1.3.0'), parseSemver('1.3.0-beta.9')), 1);
  assert.equal(compareSemver(parseSemver('1.4.0-beta.1'), parseSemver('1.3.9')), 1);
  assert.equal(compareSemver(parseSemver('1.4.0-beta.10'), parseSemver('1.4.0-beta.2')), 1);
});

test('publishes documentation without updater feeds before the first release', async () => {
  assert.deepEqual(selectFeedReleases([]), { stable: undefined, beta: undefined });
  assert.deepEqual(await generateUpdaterFeeds([]), { stable: undefined, beta: undefined });
});

test('stable feed selects stable while beta feed selects the higher stable or beta version', () => {
  let selected = selectFeedReleases([
    release('1.3.0'),
    release('1.4.0-beta.2'),
    release('1.4.0-beta.1'),
  ]);
  assert.equal(selected.stable.semver.version, '1.3.0');
  assert.equal(selected.beta.semver.version, '1.4.0-beta.2');

  selected = selectFeedReleases([release('1.4.0'), release('1.4.0-beta.2')]);
  assert.equal(selected.stable.semver.version, '1.4.0');
  assert.equal(selected.beta.semver.version, '1.4.0');
});

test('allows beta releases before the first stable release', async () => {
  const releases = [release('0.1.0-beta.1')];
  const selected = selectFeedReleases(releases);
  assert.equal(selected.stable, undefined);
  assert.equal(selected.beta.semver.version, '0.1.0-beta.1');

  const feeds = await generateUpdaterFeeds(releases, async () => ({
    ok: true,
    status: 200,
    json: async () => manifest('0.1.0-beta.1'),
  }));
  assert.equal(feeds.stable, undefined);
  assert.equal(feeds.beta.version, '0.1.0-beta.1');
});

test('ignores drafts, unrelated tags, and non-beta prereleases', () => {
  const selected = selectFeedReleases([
    release('9.0.0', { draft: true }),
    { ...release('8.0.0'), tag_name: 'v8.0.0' },
    release('7.0.0-rc.1'),
    release('1.0.0'),
  ]);
  assert.equal(selected.stable.semver.version, '1.0.0');
  assert.equal(selected.beta.semver.version, '1.0.0');
});

test('downloads selected manifests through anonymous release asset URLs', async () => {
  const releases = [release('2.0.0'), release('2.1.0-beta.1')];
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url, options });
    const version = url.split('/').at(-2);
    return { ok: true, status: 200, json: async () => manifest(version) };
  };

  const feeds = await generateUpdaterFeeds(releases, fetchImpl);
  assert.equal(feeds.stable.version, '2.0.0');
  assert.equal(feeds.beta.version, '2.1.0-beta.1');
  assert.deepEqual(requested.map(({ url }) => url), [
    'https://example.test/2.0.0/latest.json',
    'https://example.test/2.1.0-beta.1/latest.json',
  ]);
  assert.ok(requested.every(({ options }) => options.headers['User-Agent'] === 'kiki-desktop-feed'));
});
