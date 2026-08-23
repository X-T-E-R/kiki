#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(' ')}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

export function parseSemver(version) {
  const match = version.match(SEMVER);
  if (!match) return undefined;
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

export function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a);
    const bNumber = /^\d+$/.test(b);
    if (aNumber && bNumber) return Number(a) < Number(b) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function releaseCandidate(release) {
  if (release.draft || release.published_at == null) return undefined;
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!tag.startsWith('kiki-v')) return undefined;
  const semver = parseSemver(tag.slice('kiki-v'.length));
  if (semver === undefined) return undefined;
  const isStable = semver.prerelease.length === 0 && release.prerelease === false;
  const isBeta = semver.prerelease[0] === 'beta' && release.prerelease === true;
  if (!isStable && !isBeta) return undefined;
  const manifestAsset = release.assets?.find((asset) => asset.name === 'latest.json');
  if (manifestAsset?.browser_download_url === undefined) return undefined;
  return { release, semver, manifestUrl: manifestAsset.browser_download_url, isStable, isBeta };
}

function maximum(candidates) {
  return candidates.reduce(
    (current, candidate) => current === undefined || compareSemver(candidate.semver, current.semver) > 0 ? candidate : current,
    undefined,
  );
}

export function selectFeedReleases(releases) {
  const candidates = releases.map(releaseCandidate).filter((candidate) => candidate !== undefined);
  const stable = maximum(candidates.filter((candidate) => candidate.isStable));
  const latestBeta = maximum(candidates.filter((candidate) => candidate.isBeta));
  const beta = stable === undefined
    ? latestBeta
    : latestBeta !== undefined && compareSemver(latestBeta.semver, stable.semver) > 0
      ? latestBeta
      : stable;
  return { stable, beta };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kiki-desktop-feed',
    },
  });
  if (!response.ok) throw new Error(`Anonymous fetch failed for ${url}: HTTP ${response.status}`);
  return response.json();
}

function assertManifest(manifest, candidate) {
  if (manifest?.version !== candidate.semver.version) {
    throw new Error(`latest.json version does not match ${candidate.release.tag_name}`);
  }
  const platform = manifest?.platforms?.['windows-x86_64'];
  if (typeof platform?.url !== 'string' || typeof platform?.signature !== 'string') {
    throw new Error(`latest.json for ${candidate.release.tag_name} has no windows-x86_64 updater`);
  }
  return manifest;
}

export async function generateUpdaterFeeds(releases, fetchImpl = fetch) {
  const selected = selectFeedReleases(releases);
  const stable = selected.stable === undefined
    ? undefined
    : assertManifest(await fetchJson(selected.stable.manifestUrl, fetchImpl), selected.stable);
  const beta = selected.beta === undefined
    ? undefined
    : selected.beta === selected.stable
      ? stable
      : assertManifest(await fetchJson(selected.beta.manifestUrl, fetchImpl), selected.beta);
  return { stable, beta };
}

export function writeUpdaterFeeds(outputDir, feeds) {
  const root = resolve(outputDir);
  for (const channel of ['stable', 'beta']) {
    if (feeds[channel] === undefined) continue;
    const directory = join(root, channel);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(feeds[channel], null, 2)}\n`);
  }
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const repository = values.get('repository');
  const outputDir = values.get('output-dir');
  if (repository === undefined || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('--repository owner/name is required');
  if (outputDir === undefined || outputDir.trim() === '') throw new Error('--output-dir is required');
  const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=100`, fetch);
  const feeds = await generateUpdaterFeeds(releases, fetch);
  writeUpdaterFeeds(outputDir, feeds);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`[kiki updater feed] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
