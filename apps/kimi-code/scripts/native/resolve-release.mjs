import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { appRoot } from './paths.mjs';

const packageName = '@kiki/cli';
const packageJson = JSON.parse(
  await readFile(resolve(appRoot, 'package.json'), 'utf-8'),
);

function parsePublishedPackages() {
  const raw = process.env['CHANGESETS_PUBLISHED_PACKAGES'];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function outputLine(name, value) {
  return `${name}=${value}\n`;
}

const publishedPackage = parsePublishedPackages().find(
  (entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    entry.name === packageName &&
    typeof entry.version === 'string',
);

const version = publishedPackage?.version ?? packageJson.version;
const shouldPublish = publishedPackage !== undefined;
const tag = `${packageName}@${version}`;
const githubOutput = process.env['GITHUB_OUTPUT'];

if (githubOutput !== undefined) {
  await appendFile(
    githubOutput,
    [
      outputLine('should_publish', String(shouldPublish)),
      outputLine('version', version),
      outputLine('tag', tag),
    ].join(''),
  );
}

console.log(`should_publish=${String(shouldPublish)}`);
console.log(`version=${version}`);
console.log(`tag=${tag}`);
