import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { run } from './exec.mjs';
import { appRoot } from './paths.mjs';

const VERSION_RESOURCE_SCRIPT = resolve(import.meta.dirname, 'windows-version-info.ps1');
const VERSION_RESOURCE_TEMP_ROOT = resolve(appRoot, '../../.tmp');
const VERSION_RESOURCE_ID = 16;
const VERSION_RESOURCE_LANGUAGE = 0x409;
const VERSION_RESOURCE_NAME = 1;

function align4(value) {
  return (value + 3) & ~3;
}

function utf16(value) {
  return Buffer.from(`${value}\0`, 'utf16le');
}

function writeWord(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeDword(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function versionTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (!match) throw new Error(`Windows version info requires a numeric version, got ${version}`);
  const tuple = match.slice(1).map((value) => Number(value || 0));
  if (tuple.some((value) => !Number.isSafeInteger(value) || value > 0xffff)) {
    throw new Error(`Windows version info components must fit in 16 bits, got ${version}`);
  }
  return tuple;
}

function makeBlock(key, { type = 1, value = null, children = [] } = {}) {
  const keyBytes = utf16(key);
  const valueBytes = value === null ? Buffer.alloc(0) : value;
  const headerEnd = align4(6 + keyBytes.length);
  const valueEnd = align4(headerEnd + valueBytes.length);
  const childrenBytes = Buffer.concat(children);
  const totalLength = valueEnd + childrenBytes.length;
  if (totalLength > 0xffff) throw new Error(`Windows version info block is too large: ${key}`);

  const block = Buffer.alloc(totalLength);
  writeWord(block, 0, totalLength);
  writeWord(block, 2, value === null ? 0 : type === 0 ? value.length : value.length / 2);
  writeWord(block, 4, type);
  keyBytes.copy(block, 6);
  valueBytes.copy(block, headerEnd);
  childrenBytes.copy(block, valueEnd);
  return block;
}

function makeString(key, value) {
  return makeBlock(key, { value: utf16(value) });
}

function makeFixedFileInfo(version) {
  const [major, minor, patch, build] = versionTuple(version);
  const fixed = Buffer.alloc(52);
  writeDword(fixed, 0, 0xfeef04bd);
  writeDword(fixed, 4, 0x00010000);
  writeDword(fixed, 8, (major << 16) | minor);
  writeDword(fixed, 12, (patch << 16) | build);
  writeDword(fixed, 16, (major << 16) | minor);
  writeDword(fixed, 20, (patch << 16) | build);
  writeDword(fixed, 24, 0x0000003f);
  writeDword(fixed, 28, 0x00000000);
  writeDword(fixed, 32, 0x00040004);
  writeDword(fixed, 36, 0x00000001);
  writeDword(fixed, 40, 0x00000000);
  writeDword(fixed, 44, 0x00000000);
  writeDword(fixed, 48, 0x00000000);
  return fixed;
}

export function buildVersionInfoResource({ version, description, productName = 'Kiki', author = 'Kiki' }) {
  const stringTable = makeBlock('040904B0', {
    children: [
      makeString('CompanyName', author),
      makeString('FileDescription', description),
      makeString('FileVersion', version),
      makeString('InternalName', 'kiki'),
      makeString('OriginalFilename', 'kiki.exe'),
      makeString('ProductName', productName),
      makeString('ProductVersion', version),
    ],
  });
  const stringFileInfo = makeBlock('StringFileInfo', { children: [stringTable] });
  const translation = Buffer.alloc(4);
  writeWord(translation, 0, 0x0409);
  writeWord(translation, 2, 0x04b0);
  const varFileInfo = makeBlock('VarFileInfo', {
    children: [makeBlock('Translation', { type: 0, value: translation })],
  });
  return makeBlock('VS_VERSION_INFO', {
    type: 0,
    value: makeFixedFileInfo(version),
    children: [stringFileInfo, varFileInfo],
  });
}

async function readPackageMetadata() {
  const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf8'));
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('apps/kimi-code/package.json must provide a version for Windows version info');
  }
  if (typeof packageJson.description !== 'string' || packageJson.description.length === 0) {
    throw new Error('apps/kimi-code/package.json must provide a description for Windows version info');
  }
  return {
    version: packageJson.version,
    description: packageJson.description,
    author: typeof packageJson.author === 'string' ? packageJson.author : 'Kiki',
  };
}

export async function applyWindowsVersionInfo(executable) {
  if (process.platform !== 'win32') return;
  const metadata = await readPackageMetadata();
  const resource = buildVersionInfoResource(metadata);
  await mkdir(VERSION_RESOURCE_TEMP_ROOT, { recursive: true });
  const tempRoot = await mkdtemp(resolve(VERSION_RESOURCE_TEMP_ROOT, 'kiki-version-info-'));
  const resourcePath = resolve(tempRoot, 'version-info.bin');
  try {
    await writeFile(resourcePath, resource);
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      VERSION_RESOURCE_SCRIPT,
      '-Executable',
      executable,
      '-ResourceFile',
      resourcePath,
      '-ResourceType',
      String(VERSION_RESOURCE_ID),
      '-ResourceName',
      String(VERSION_RESOURCE_NAME),
      '-Language',
      String(VERSION_RESOURCE_LANGUAGE),
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
