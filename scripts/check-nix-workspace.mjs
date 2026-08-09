#!/usr/bin/env node
/* eslint-disable no-console -- This file is a command-line checker. */
/**
 * Verify that every package selected by pnpm-workspace.yaml is present in both
 * flake.nix workspace lists. Exit code 0 means the lists are exactly in sync;
 * exit code 1 means at least one package is missing or stale.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

/**
 * Convert a workspace directory to the slash-separated form used by Nix.
 *
 * @param {string} dir
 */
export function normalizeWorkspaceDir(dir) {
  return dir
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/**
 * Parse the package patterns from pnpm-workspace.yaml.
 *
 * @param {string} root
 */
export function getWorkspaceGlobs(root) {
  const yamlPath = join(root, "pnpm-workspace.yaml");
  const lines = readFileSync(yamlPath, "utf8").split(/\r?\n/);
  const globs = [];
  let inPackages = false;

  for (const line of lines) {
    if (line.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    const match = line.match(/^\s+-\s+(.+?)\s*$/);
    if (match) {
      const value = match[1];
      globs.push(
        (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value,
      );
    } else if (line.trim() !== "" && !line.startsWith(" ")) {
      break;
    }
  }

  return globs;
}

/**
 * Expand the simple directory patterns used by this repository. Unsupported
 * patterns fail closed instead of silently weakening the sync check.
 *
 * @param {string} root
 * @param {string[]} globs
 */
export function expandWorkspaceGlobs(root, globs) {
  const dirs = new Set();

  for (const rawGlob of globs) {
    const excluded = rawGlob.startsWith("!");
    const glob = normalizeWorkspaceDir(excluded ? rawGlob.slice(1) : rawGlob);
    /** @type {string[]} */
    let matches;

    if (glob.endsWith("/*") && !glob.slice(0, -2).includes("*")) {
      const base = glob.slice(0, -2);
      const basePath = join(root, ...base.split("/"));
      matches = existsSync(basePath)
        ? readdirSync(basePath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${base}/${entry.name}`)
        : [];
    } else if (!glob.includes("*")) {
      const candidate = join(root, ...glob.split("/"));
      matches = existsSync(candidate) ? [glob] : [];
    } else {
      throw new Error(`Unsupported pnpm workspace pattern: ${rawGlob}`);
    }

    for (const match of matches) {
      if (excluded) dirs.delete(match);
      else dirs.add(match);
    }
  }

  return [...dirs].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Read package names and normalized relative paths for all workspace packages.
 *
 * @param {string} root
 * @param {string[]} dirs
 */
export function buildWorkspacePackages(root, dirs) {
  /** @type {Array<{name: string, dir: string, path: string}>} */
  const packages = [];
  const names = new Set();

  for (const rawDir of dirs) {
    const dir = normalizeWorkspaceDir(rawDir);
    const pkgPath = join(root, ...dir.split("/"), "package.json");
    if (!existsSync(pkgPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg.name) continue;
    if (names.has(pkg.name)) {
      throw new Error(`Duplicate workspace package name: ${pkg.name}`);
    }

    names.add(pkg.name);
    packages.push({ name: pkg.name, dir, path: `./${dir}` });
  }

  return packages.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parse workspaceNames and workspacePaths from flake.nix.
 *
 * @param {string} root
 */
export function parseFlakeNix(root) {
  const content = readFileSync(join(root, "flake.nix"), "utf8");

  function extractArray(label) {
    const match = content.match(new RegExp(`${label}\\s*=\\s*\\[(.*?)\\]`, "s"));
    if (!match) throw new Error(`Could not find ${label} in flake.nix`);

    if (label === "workspacePaths") {
      return [...match[1].matchAll(/\.\/[^\s\]]+/g)].map((item) =>
        `./${normalizeWorkspaceDir(item[0])}`,
      );
    }
    return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  }

  return {
    names: extractArray("workspaceNames"),
    paths: extractArray("workspacePaths"),
  };
}

/**
 * Compare the pnpm workspace package set with both Nix lists.
 *
 * @param {string} [root]
 */
export function checkNixWorkspace(root = DEFAULT_ROOT) {
  const dirs = expandWorkspaceGlobs(root, getWorkspaceGlobs(root));
  const packages = buildWorkspacePackages(root, dirs);
  const flake = parseFlakeNix(root);
  const expectedNames = new Set(packages.map((pkg) => pkg.name));
  const expectedPaths = new Set(packages.map((pkg) => pkg.path));
  const flakeNames = new Set(flake.names);
  const flakePaths = new Set(flake.paths);

  const missingNames = packages
    .filter((pkg) => !flakeNames.has(pkg.name))
    .map((pkg) => pkg.name);
  const missingPaths = packages
    .filter((pkg) => !flakePaths.has(pkg.path))
    .map((pkg) => ({ name: pkg.name, path: pkg.path }));
  const extraNames = flake.names
    .filter((name) => !expectedNames.has(name))
    .toSorted();
  const extraPaths = flake.paths
    .filter((path) => !expectedPaths.has(path))
    .toSorted();

  return {
    ok:
      missingNames.length === 0 &&
      missingPaths.length === 0 &&
      extraNames.length === 0 &&
      extraPaths.length === 0,
    packages,
    missingNames,
    missingPaths,
    extraNames,
    extraPaths,
  };
}

function printList(title, values) {
  if (values.length === 0) return;
  console.error(title);
  for (const value of values) console.error(`  - ${value}`);
  console.error("");
}

export function main() {
  const result = checkNixWorkspace();
  if (result.ok) {
    console.log(
      `✅ All ${result.packages.length} pnpm workspace packages are in sync with flake.nix.`,
    );
    return;
  }

  console.error("❌ flake.nix workspace lists are out of sync.\n");
  printList(
    "Workspace packages missing from flake.nix workspaceNames:",
    result.missingNames,
  );
  printList(
    "Workspace packages missing from flake.nix workspacePaths:",
    result.missingPaths.map(({ name, path }) => `${path}  (${name})`),
  );
  printList("Stale entries in flake.nix workspaceNames:", result.extraNames);
  printList("Stale entries in flake.nix workspacePaths:", result.extraPaths);
  console.error(
    "Update workspaceNames and workspacePaths so they exactly match pnpm-workspace.yaml.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main();
}
