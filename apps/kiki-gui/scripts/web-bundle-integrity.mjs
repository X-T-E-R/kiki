import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const ASSET_ATTR_RE =
  /\b(?:src|href)\s*=\s*(?:"(\/assets\/[^"?#]+)(?:[?#][^"]*)?"|'(\/assets\/[^'?#]+)(?:[?#][^']*)?')/gi;

export function extractHtmlAssetPaths(indexHtml) {
  if (typeof indexHtml !== 'string' || indexHtml.trim() === '') {
    return [];
  }
  const stripped = indexHtml.replace(HTML_COMMENT_RE, '');
  const seen = new Set();
  for (const match of stripped.matchAll(ASSET_ATTR_RE)) {
    const rawPath = match[1] ?? match[2] ?? '';
    const relPath = rawPath.replace(/^\/+/, '');
    if (relPath !== '' && !relPath.split('/').includes('..')) {
      seen.add(relPath);
    }
  }
  return [...seen];
}

export async function countRegularFiles(dirPath) {
  const entries = await readdir(dirPath, { recursive: true, withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}

async function assertNonEmptyFile(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`${label} is empty or not a regular file: ${filePath}`);
  }
  return info.size;
}

export async function assertWebBundleIntegrity(webDir, options = {}) {
  const resolvedWebDir = resolve(webDir);
  const minFileCount = options.minFileCount ?? 1;
  const indexPath = resolve(resolvedWebDir, 'index.html');
  await assertNonEmptyFile(indexPath, 'Web bundle index.html');

  const indexHtml = await readFile(indexPath, 'utf8');
  const referencedAssets = extractHtmlAssetPaths(indexHtml);
  if (referencedAssets.length === 0) {
    throw new Error(
      `Web bundle index.html does not reference any /assets/* entrypoints: ${indexPath}`,
    );
  }

  const missingAssets = [];
  for (const relAsset of referencedAssets) {
    const assetPath = resolve(resolvedWebDir, relAsset);
    const relCheck = relative(resolvedWebDir, assetPath);
    if (relCheck.startsWith('..')) {
      missingAssets.push(`${relAsset} (escapes web root)`);
      continue;
    }
    try {
      const info = await stat(assetPath);
      if (!info.isFile() || info.size <= 0) {
        missingAssets.push(`${relAsset} (empty)`);
      }
    } catch {
      missingAssets.push(relAsset);
    }
  }
  if (missingAssets.length > 0) {
    throw new Error(
      `Web bundle integrity check failed at ${resolvedWebDir}; missing or empty entrypoint asset(s): ${missingAssets.join(', ')}`,
    );
  }

  const fileCount = await countRegularFiles(resolvedWebDir);
  if (fileCount < minFileCount) {
    throw new Error(
      `Web bundle at ${resolvedWebDir} appears truncated: found ${fileCount} files, expected at least ${minFileCount}.`,
    );
  }

  if (options.sourceDistDir !== undefined) {
    const resolvedSourceDir = resolve(options.sourceDistDir);
    const sourceFileCount = await countRegularFiles(resolvedSourceDir);
    if (sourceFileCount < minFileCount) {
      throw new Error(
        `Source GUI dist at ${resolvedSourceDir} appears truncated: found ${sourceFileCount} files, expected at least ${minFileCount}.`,
      );
    }
    if (fileCount !== sourceFileCount) {
      throw new Error(
        `Web bundle copy mismatch: source ${resolvedSourceDir} has ${sourceFileCount} files, staged ${resolvedWebDir} has ${fileCount} files.`,
      );
    }
  }

  return {
    webDir: resolvedWebDir,
    fileCount,
    referencedAssets,
  };
}

export async function stageWebBundle(options) {
  const sourceDistDir = resolve(options.sourceDistDir);
  const targetWebDir = resolve(options.targetWebDir);
  const minFileCount = options.minFileCount ?? 100;

  await assertWebBundleIntegrity(sourceDistDir, { minFileCount });
  await rm(targetWebDir, { recursive: true, force: true });
  await cp(sourceDistDir, targetWebDir, { recursive: true });
  return assertWebBundleIntegrity(targetWebDir, { sourceDistDir, minFileCount });
}
