#!/usr/bin/env node
/**
 * Real CPU-burning deterministic build/AST/hash/zlib verifier executed by Kiki
 * native Bash tool calls during S10 / 256 / 1,024 workloads (Astra v2.2 §3).
 *
 * ZERO sleep-for-load, ZERO constant padding. Computes genuine syntax token counts,
 * exported symbol signatures, SHA-256 + BLAKE2s256 leaves, Merkle root, zlib
 * gzip/gunzip round-trip verification, and optional short-lived worker subprocess
 * partitions, emitting structured JSONL rows + content-derived footer digest.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|"[^"\n]*"|'[^'\n]*'|[{}()[\];,.:=+\-*/<>!&|?]/gu;
const EXPORT_RE = /export\s+(?:const|let|var|function|class|type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu;
const IMPORT_RE = /import\s+[^;]*?from\s+['"]([^'"]+)['"]/gu;
const CONST_NUM_RE = /export\s+const\s+([A-Z0-9_]+)\s*=\s*(\d+)/gu;

export function domainSha256(domain, fields) {
  const h = createHash('sha256');
  const writeStr = (s) => {
    const b = Buffer.from(String(s), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    h.update(len);
    h.update(b);
  };
  writeStr(domain);
  for (const f of fields) {
    if (Buffer.isBuffer(f) || f instanceof Uint8Array) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(f.byteLength, 0);
      h.update(len);
      h.update(f);
    } else {
      writeStr(f);
    }
  }
  return h.digest('hex');
}

export function analyzeModuleBytes(relPath, rawBytes, needle) {
  const text = rawBytes.toString('utf8');
  const tokens = text.match(TOKEN_RE) ?? [];
  const exports = [];
  for (const m of text.matchAll(EXPORT_RE)) exports.push(m[1]);
  const imports = [];
  for (const m of text.matchAll(IMPORT_RE)) imports.push(m[1]);
  const numericConstants = {};
  for (const m of text.matchAll(CONST_NUM_RE)) numericConstants[m[1]] = Number(m[2]);

  const sha256 = createHash('sha256').update(rawBytes).digest('hex');
  const blake2 = createHash('blake2s256').update(rawBytes).digest('hex');
  const compressed = gzipSync(rawBytes, { level: 4 });
  const roundTrip = gunzipSync(compressed);
  const check = Buffer.compare(rawBytes, roundTrip) === 0;
  if (!check) {
    throw new Error(`zlib round-trip verification failed for ${relPath}`);
  }
  let needleHits = 0;
  if (needle) {
    let idx = 0;
    while ((idx = text.indexOf(needle, idx)) !== -1) {
      needleHits += 1;
      idx += needle.length;
    }
  }
  return {
    module: relPath.replaceAll('\\', '/'),
    bytes: rawBytes.length,
    tokenCount: tokens.length,
    signature: exports.slice(0, 8).join(',') || 'none',
    importCount: imports.length,
    imports: imports.slice(0, 8),
    numericConstants,
    sha256,
    blake2,
    gzipBytes: compressed.length,
    needleHits,
    check,
  };
}

export function computeMerkleRoot(leafHashes) {
  if (leafHashes.length === 0) return domainSha256('merkle/empty/v2', []);
  let layer = [...leafHashes];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = layer[i + 1] ?? left;
      next.push(domainSha256('merkle/node/v2', [left, right]));
    }
    layer = next;
  }
  return layer[0];
}

export function runAstBuild({
  rootDir,
  files,
  challenge = 'default',
  needle = '',
  passes = 1,
  partitions = 1,
}) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  const sortedFiles = [...files].map((f) => f.replaceAll('\\', '/')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const records = [];
  let bytesRead = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    for (const relPath of sortedFiles) {
      const absPath = path.resolve(rootDir, relPath);
      const rawBytes = fs.readFileSync(absPath);
      bytesRead += rawBytes.length;
      const analysis = analyzeModuleBytes(relPath, rawBytes, needle);
      const leaf = domainSha256('ast-leaf/v2', [challenge, String(pass), analysis.module, analysis.sha256, analysis.blake2, String(analysis.tokenCount)]);
      records.push({
        pass,
        ...analysis,
        leaf,
      });
    }
  }

  let childPartitionCount = 0;
  if (partitions > 1 && sortedFiles.length >= 2) {
    const sliceSize = Math.max(1, Math.ceil(sortedFiles.length / partitions));
    for (let p = 0; p < partitions; p += 1) {
      const chunk = sortedFiles.slice(p * sliceSize, (p + 1) * sliceSize);
      if (chunk.length === 0) continue;
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          '--root', rootDir,
          '--challenge', `${challenge}:p${p}`,
          '--files', chunk.join(','),
          '--passes', '1',
          '--partitions', '1',
          '--quiet',
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (child.status !== 0) {
        throw new Error(`Partition ${p} failed (exit ${child.status}): ${child.stderr}`);
      }
      childPartitionCount += 1;
    }
  }

  const merkleRoot = computeMerkleRoot(records.map((r) => r.leaf));
  const rowLines = records.map((r) => JSON.stringify(r));
  const rowsBody = rowLines.join('\n');
  const footerDigest = domainSha256('ast-build-footer/v2', [challenge, merkleRoot, String(records.length), String(bytesRead), rowsBody]);
  const cpuDelta = process.cpuUsage(cpuStart);
  const cpuMs = Number(((cpuDelta.user + cpuDelta.system) / 1000).toFixed(2));
  const wallMs = Number((performance.now() - wallStart).toFixed(2));

  return {
    rowLines,
    footer: {
      type: 'ast_build_footer',
      version: 2,
      challenge,
      recordCount: records.length,
      fileCount: sortedFiles.length,
      bytesRead,
      merkleRoot,
      footerDigest,
      partitionsExecuted: childPartitionCount,
      cpuMs,
      wallMs,
    },
  };
}

function collectSourceFiles(dir, maxFiles = 200) {
  const out = [];
  const walk = (cur) => {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function parseCliArgs(argv) {
  const opts = { root: process.cwd(), dir: null, files: [], challenge: 'cli', needle: '', passes: 1, partitions: 1, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.root = argv[++i];
    else if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--files') opts.files = argv[++i].split(',').filter(Boolean);
    else if (arg === '--challenge') opts.challenge = argv[++i];
    else if (arg === '--needle') opts.needle = argv[++i];
    else if (arg === '--passes') opts.passes = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--partitions') opts.partitions = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--quiet') opts.quiet = true;
  }
  if (opts.dir && opts.files.length === 0) {
    opts.root = path.resolve(opts.dir);
    opts.files = collectSourceFiles(opts.root);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.files.length === 0) {
    process.stderr.write('ast-build.mjs: --files is required\n');
    process.exit(2);
  }
  const result = runAstBuild({
    rootDir: opts.root,
    files: opts.files,
    challenge: opts.challenge,
    needle: opts.needle,
    passes: opts.passes,
    partitions: opts.partitions,
  });
  if (!opts.quiet) {
    for (const line of result.rowLines) {
      process.stdout.write(`${line}\n`);
    }
  }
  process.stdout.write(`AST_BUILD_FOOTER ${JSON.stringify(result.footer)}\n`);
}
