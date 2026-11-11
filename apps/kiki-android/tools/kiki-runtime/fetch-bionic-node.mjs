#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const LOCK_PATH = path.join(SCRIPT_DIR, 'node.lock');
const DEFAULT_CACHE_DIR = path.join(REPO_ROOT, 'build', 'kiki-node-cache');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'kiki-runtime', 'build', 'generated', 'jniLibs');

// Android PackageManager NativeLibraryHelper only extracts APK lib/<abi>/* entries matching /^lib.*\.so$/
// (no trailing version digits like `.so.3` or `.so.79`). We normalize versioned SONAMEs & DT_NEEDED in-place
// in ELF `.dynstr` (padded with NULs, shorter or equal length, zero layout shift) so every library ends with `.so`.
const SONAME_NORMALIZE_MAP = new Map([
  ['libz.so.1', 'libz_t.so'],
  ['libcrypto.so.3', 'libcrypto_3.so'],
  ['libssl.so.3', 'libssl_3.so'],
  ['libicui18n.so.79', 'libicui18n_79.so'],
  ['libicuuc.so.79', 'libicuuc_79.so'],
  ['libicudata.so.79', 'libicudata_79.so'],
]);

function normalizeSoName(name) {
  return SONAME_NORMALIZE_MAP.get(name) ?? name;
}

function parseArgs(argv) {
  let abis = ['x86_64', 'arm64-v8a'];
  let outDir = DEFAULT_OUT_DIR;
  let cacheDir = DEFAULT_CACHE_DIR;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--abi' && argv[i + 1]) {
      abis = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--abi=')) {
      abis = arg.slice(6).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--out' && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--out=')) {
      outDir = path.resolve(arg.slice(6));
    } else if (arg === '--cache' && argv[i + 1]) {
      cacheDir = path.resolve(argv[++i]);
    } else if (arg.startsWith('--cache=')) {
      cacheDir = path.resolve(arg.slice(8));
    }
  }
  return { abis, outDir, cacheDir };
}

function parseLockFile(lockText) {
  const entries = [];
  for (const rawLine of lockText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] !== 'deb' || parts.length !== 6) {
      throw new Error(`Invalid node.lock line: ${rawLine}`);
    }
    const [, abi, name, version, url, sha256] = parts;
    entries.push({ abi, name, version, url, sha256: sha256.toLowerCase() });
  }
  return entries;
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchVerifiedDeb(entry, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const safeFile = `${entry.abi}__${entry.name}__${entry.version.replace(/[^A-Za-z0-9._+-]/g, '_')}.deb`;
  const cachedPath = path.join(cacheDir, safeFile);
  if (fs.existsSync(cachedPath)) {
    const existing = fs.readFileSync(cachedPath);
    if (sha256Buffer(existing) === entry.sha256) {
      return existing;
    }
    fs.unlinkSync(cachedPath);
  }
  console.log(`[fetch-bionic-node] Downloading ${entry.abi}/${entry.name}@${entry.version} ...`);
  const res = await fetch(entry.url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${entry.url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256Buffer(buf);
  if (actual !== entry.sha256) {
    throw new Error(`SHA-256 mismatch for ${entry.url}: expected ${entry.sha256}, got ${actual}`);
  }
  const tmpPath = `${cachedPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, buf);
  fs.renameSync(tmpPath, cachedPath);
  return buf;
}

function parseArArchive(buf) {
  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== '!<arch>\n') {
    throw new Error(`Invalid deb ar header: ${JSON.stringify(magic)}`);
  }
  const members = new Map();
  let offset = 8;
  while (offset + 60 <= buf.length) {
    const header = buf.subarray(offset, offset + 60);
    const rawName = header.subarray(0, 16).toString('ascii').trim().replace(/\/$/, '');
    const size = parseInt(header.subarray(48, 58).toString('ascii').trim(), 10);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid ar member size at offset ${offset}`);
    }
    const dataStart = offset + 60;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated ar member ${rawName}`);
    }
    members.set(rawName, buf.subarray(dataStart, dataEnd));
    offset = dataEnd + (size % 2);
  }
  return members;
}

function decompressDataTar(members, tmpDir) {
  for (const [name, payload] of members.entries()) {
    if (!name.startsWith('data.tar')) continue;
    const tarPath = path.join(tmpDir, 'data.tar');
    if (name === 'data.tar') {
      fs.writeFileSync(tarPath, payload);
      return tarPath;
    }
    if (name === 'data.tar.gz') {
      fs.writeFileSync(tarPath, zlib.gunzipSync(payload));
      return tarPath;
    }
    if (name === 'data.tar.xz') {
      const xzPath = path.join(tmpDir, 'data.tar.xz');
      fs.writeFileSync(xzPath, payload);
      execFileSync('xz', ['-d', '-f', xzPath], { stdio: 'inherit' });
      return tarPath;
    }
    if (name === 'data.tar.zst') {
      const zstPath = path.join(tmpDir, 'data.tar.zst');
      fs.writeFileSync(zstPath, payload);
      execFileSync('zstd', ['-d', '-f', zstPath, '-o', tarPath], { stdio: 'inherit' });
      return tarPath;
    }
  }
  throw new Error(`No data.tar.* found in archive (${[...members.keys()].join(', ')})`);
}

function parseTarEntries(tarBuf) {
  const entries = [];
  let offset = 0;
  let nextLongName = null;
  let nextLongLink = null;

  const readCString = (slice) => {
    const zero = slice.indexOf(0);
    return (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8');
  };

  while (offset + 512 <= tarBuf.length) {
    const block = tarBuf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;

    const sizeOctal = readCString(block.subarray(124, 136)).trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const typeFlag = String.fromCharCode(block[156] || 48);
    const prefix = readCString(block.subarray(345, 500));
    const baseName = readCString(block.subarray(0, 100));
    let entryName = nextLongName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    let linkName = nextLongLink ?? readCString(block.subarray(157, 257));
    nextLongName = null;
    nextLongLink = null;

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const alignedEnd = dataStart + Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      nextLongName = readCString(tarBuf.subarray(dataStart, dataEnd));
      offset = alignedEnd;
      continue;
    }
    if (typeFlag === 'K') {
      nextLongLink = readCString(tarBuf.subarray(dataStart, dataEnd));
      offset = alignedEnd;
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g') {
      offset = alignedEnd;
      continue;
    }

    entryName = entryName.replace(/^\.\//, '');
    entries.push({
      name: entryName,
      typeFlag,
      linkName,
      data: typeFlag === '0' || typeFlag === '\0' ? tarBuf.subarray(dataStart, dataEnd) : null,
    });
    offset = alignedEnd;
  }
  return entries;
}

function inspectAndPatchElf(rawBuf) {
  const buf = Buffer.from(rawBuf);
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error('Not a valid ELF64 binary');
  }
  const is64 = buf[4] === 2;
  const littleEndian = buf[5] === 1;
  if (!is64 || !littleEndian) {
    throw new Error(`Unsupported ELF class/endianness: class=${buf[4]}, endian=${buf[5]}`);
  }
  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);

  const segments = [];
  let dynOffset = 0;
  let dynSize = 0;
  let interp = null;

  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    const pType = buf.readUInt32LE(p);
    const pOffset = Number(buf.readBigUInt64LE(p + 8));
    const pVaddr = Number(buf.readBigUInt64LE(p + 16));
    const pFilesz = Number(buf.readBigUInt64LE(p + 32));
    const pMemsz = Number(buf.readBigUInt64LE(p + 40));
    if (pType === 1) {
      segments.push({ pOffset, pVaddr, pFilesz, pMemsz });
    } else if (pType === 2) {
      dynOffset = pOffset;
      dynSize = pFilesz;
    } else if (pType === 3) {
      const slice = buf.subarray(pOffset, pOffset + pFilesz);
      const zero = slice.indexOf(0);
      interp = (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8');
    }
  }

  const vaddrToOffset = (vaddr) => {
    for (const s of segments) {
      if (vaddr >= s.pVaddr && vaddr < s.pVaddr + s.pFilesz) {
        return s.pOffset + (vaddr - s.pVaddr);
      }
    }
    return -1;
  };

  const neededOffsets = [];
  let strtabVaddr = 0;
  let sonameOffset = -1;
  let rpathDynPos = -1;
  let runpathDynPos = -1;

  for (let off = dynOffset; off + 16 <= dynOffset + dynSize; off += 16) {
    const tag = Number(buf.readBigInt64LE(off));
    const val = Number(buf.readBigUInt64LE(off + 8));
    if (tag === 0) break;
    if (tag === 1) neededOffsets.push(val);
    else if (tag === 5) strtabVaddr = val;
    else if (tag === 14) sonameOffset = val;
    else if (tag === 15) rpathDynPos = off;
    else if (tag === 29) runpathDynPos = off;
  }

  const strtabFileOffset = vaddrToOffset(strtabVaddr);
  if (strtabFileOffset < 0) {
    throw new Error('Could not resolve ELF DT_STRTAB file offset');
  }

  const readDynStr = (strOff) => {
    if (strOff < 0) return null;
    const start = strtabFileOffset + strOff;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    return buf.subarray(start, end).toString('utf8');
  };

  const patchDynStrInPlace = (strOff) => {
    if (strOff < 0) return;
    const start = strtabFileOffset + strOff;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    const orig = buf.subarray(start, end).toString('utf8');
    const replacement = SONAME_NORMALIZE_MAP.get(orig);
    if (!replacement) return;
    if (Buffer.byteLength(replacement, 'utf8') > end - start) {
      throw new Error(`Replacement SONAME ${replacement} is longer than ${orig}`);
    }
    buf.fill(0, start, end + 1);
    buf.write(replacement, start, 'utf8');
  };

  const clearRunpath = (dynPos) => {
    if (dynPos < 0) return;
    const strOff = Number(buf.readBigUInt64LE(dynPos + 8));
    const start = strtabFileOffset + strOff;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    const current = buf.subarray(start, end).toString('utf8');
    if (current.includes('com.termux') && end - start >= 7) {
      // Replace hardcoded /data/data/com.termux/... runpath with `$ORIGIN` so dynamic linker resolves sibling .so automatically!
      buf.fill(0, start, end + 1);
      buf.write('$ORIGIN', start, 'utf8');
    }
  };

  // Record original needed names before patching so we can locate them in Termux lib dir,
  // then patch DT_SONAME, DT_NEEDED, and DT_RUNPATH/DT_RPATH in place.
  const rawNeeded = neededOffsets.map(readDynStr).filter(Boolean);
  if (sonameOffset >= 0) patchDynStrInPlace(sonameOffset);
  for (const off of neededOffsets) patchDynStrInPlace(off);
  clearRunpath(rpathDynPos);
  clearRunpath(runpathDynPos);

  return {
    patchedBuffer: buf,
    interp,
    soname: sonameOffset >= 0 ? readDynStr(sonameOffset) : null,
    rpath: rpathDynPos >= 0 ? readDynStr(Number(buf.readBigUInt64LE(rpathDynPos + 8))) : null,
    runpath: runpathDynPos >= 0 ? readDynStr(Number(buf.readBigUInt64LE(runpathDynPos + 8))) : null,
    rawNeeded,
    needed: neededOffsets.map(readDynStr).filter(Boolean),
  };
}

const SYSTEM_BIONIC_LIBS = new Set([
  'libc.so',
  'libm.so',
  'libdl.so',
  'liblog.so',
  'librt.so',
  'libpthread.so',
]);

async function stageAbi(abi, entries, outDir, cacheDir) {
  const abiEntries = entries.filter((e) => e.abi === abi);
  if (abiEntries.length === 0) {
    throw new Error(`No entries in node.lock for ABI ${abi}`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(cacheDir, `extract-${abi}-`));
  try {
    const fileMap = new Map();
    const linkMap = new Map();

    for (const entry of abiEntries) {
      const debBuf = await fetchVerifiedDeb(entry, cacheDir);
      const members = parseArArchive(debBuf);
      const tarPath = decompressDataTar(members, workDir);
      const tarEntries = parseTarEntries(fs.readFileSync(tarPath));
      fs.unlinkSync(tarPath);

      for (const item of tarEntries) {
        if (item.data) {
          fileMap.set(item.name, item.data);
        } else if (item.typeFlag === '2' && item.linkName) {
          linkMap.set(item.name, item.linkName);
        }
      }
    }

    const resolveVirtualFile = (virtualPath, depth = 0) => {
      if (depth > 8) throw new Error(`Symlink loop resolving ${virtualPath}`);
      if (fileMap.has(virtualPath)) return fileMap.get(virtualPath);
      if (linkMap.has(virtualPath)) {
        const target = linkMap.get(virtualPath);
        const resolved = target.startsWith('/')
          ? target.replace(/^\/+/, '')
          : path.posix.normalize(path.posix.join(path.posix.dirname(virtualPath), target));
        return resolveVirtualFile(resolved, depth + 1);
      }
      return null;
    };

    const prefix = 'data/data/com.termux/files/usr';
    const nodeBin = resolveVirtualFile(`${prefix}/bin/node`);
    if (!nodeBin) {
      throw new Error(`Missing ${prefix}/bin/node in extracted packages for ${abi}`);
    }

    const libCandidates = new Map();
    for (const key of [...fileMap.keys(), ...linkMap.keys()]) {
      if (key.startsWith(`${prefix}/lib/lib`) && key.includes('.so')) {
        const base = path.posix.basename(key);
        const data = resolveVirtualFile(key);
        if (data) libCandidates.set(base, data);
      }
    }

    const abiOutDir = path.join(outDir, abi);
    const stagingDir = `${abiOutDir}.staging-${process.pid}`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const stagedFiles = new Map();
    const queue = [{ rawName: 'node', outName: 'libkiki_node.so', data: nodeBin }];
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current.outName)) continue;
      visited.add(current.outName);

      const elfInfo = inspectAndPatchElf(current.data);
      stagedFiles.set(current.outName, { data: elfInfo.patchedBuffer, elfInfo });

      for (const rawDep of elfInfo.rawNeeded) {
        if (SYSTEM_BIONIC_LIBS.has(rawDep)) continue;
        const normalizedDep = normalizeSoName(rawDep);
        if (visited.has(normalizedDep)) continue;
        const depData = libCandidates.get(rawDep);
        if (!depData) {
          throw new Error(`Unresolved DT_NEEDED ${rawDep} required by ${current.outName} (${abi})`);
        }
        queue.push({ rawName: rawDep, outName: normalizedDep, data: depData });
      }
    }

    const nonSoNames = [...stagedFiles.keys()].filter((name) => !/^lib[A-Za-z0-9_+.-]*\.so$/.test(name));
    if (nonSoNames.length > 0) {
      throw new Error(`Invalid jniLibs filenames for Android APK unpacker: ${nonSoNames.join(', ')}`);
    }

    for (const [fileName, { data, elfInfo }] of stagedFiles.entries()) {
      const targetPath = path.join(stagingDir, fileName);
      fs.writeFileSync(targetPath, data, { mode: 0o755 });
      console.log(
        `[fetch-bionic-node] ${abi}/${fileName} (${(data.length / (1024 * 1024)).toFixed(2)} MiB) runpath=${elfInfo.runpath ?? '-'} needed=[${elfInfo.needed.join(', ')}]`,
      );
    }

    fs.rmSync(abiOutDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(abiOutDir), { recursive: true });
    fs.renameSync(stagingDir, abiOutDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const { abis, outDir, cacheDir } = parseArgs(process.argv.slice(2));
  const entries = parseLockFile(fs.readFileSync(LOCK_PATH, 'utf8'));
  for (const abi of abis) {
    await stageAbi(abi, entries, outDir, cacheDir);
  }
}

main().catch((err) => {
  console.error('[fetch-bionic-node] Fatal:', err);
  process.exit(1);
});
