#!/usr/bin/env node
/**
 * Build SEA, stage the sidecar, and build desktop artifacts for one detached tree.
 * A receipt is written only when that sequence finishes and the tree is unchanged.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertBuildSnapshot,
  assertEvidenceRef,
  assertFullCommit,
  assertSameSnapshot,
  createReceiptForCandidate,
  defaultCandidateRoot,
  execGitReadonly,
  localBuildSteps,
  readBuildTreeSnapshot,
  receiptPathFor,
  stageServerArtifact,
  writeReceiptAtomic,
} from './desktop-build-source.mjs';

export function parseLocalBuildArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || name === '--' || value === undefined || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(' ')}`);
    }
    values.set(name, value);
  }
  const allowed = new Set(['--build-tree', '--source-commit', '--acceptance-ref', '--check-ref']);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown argument: ${name}`);
  }
  const required = (name) => {
    const value = values.get(name);
    if (value === undefined || value.trim() === '') throw new Error(`${name} is required`);
    return value;
  };
  return {
    buildTree: required('--build-tree'),
    sourceCommit: required('--source-commit'),
    acceptanceRef: required('--acceptance-ref'),
    checkRef: required('--check-ref'),
  };
}

export function runPnpmStep(step, { capture = false } = {}) {
  return new Promise((resolveStep, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: step.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveStep(capture ? stdout.trim() : undefined);
        return;
      }
      const detail = stderr.trim() === '' ? '' : `: ${stderr.trim()}`;
      reject(new Error(`${step.id} failed (${code ?? signal})${detail}`));
    });
  });
}

export async function runLocalDesktopBuild({
  buildTree,
  sourceCommit,
  acceptanceRef,
  checkRef,
  env = process.env,
  git = execGitReadonly,
  runner = runPnpmStep,
} = {}) {
  const tree = resolve(buildTree ?? '');
  const commit = assertFullCommit(sourceCommit);
  const acceptance = assertEvidenceRef(acceptanceRef, 'acceptance');
  const check = assertEvidenceRef(checkRef, 'check');
  if (!existsSync(tree) || !statSync(tree).isDirectory()) {
    throw new Error(`Build tree does not exist: ${tree}`);
  }
  const started = await readBuildTreeSnapshot(tree, git);
  assertBuildSnapshot(started, commit);
  for (const step of localBuildSteps(tree, commit, env)) {
    await runner(step);
  }
  const finished = await readBuildTreeSnapshot(tree, git);
  assertSameSnapshot(started, finished);
  assertBuildSnapshot(finished, commit);
  const candidateRoot = defaultCandidateRoot(tree);
  stageServerArtifact(tree, candidateRoot);
  const receipt = createReceiptForCandidate({
    buildTree: tree,
    candidateRoot,
    sourceCommit: commit,
    acceptanceRef: acceptance,
    checkRef: check,
  });
  const path = receiptPathFor(candidateRoot);
  writeReceiptAtomic(path, receipt);
  return { path, receipt };
}

function main() {
  let options;
  try {
    options = parseLocalBuildArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  runLocalDesktopBuild(options)
    .then((result) => {
      process.stdout.write(`${result.path}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
