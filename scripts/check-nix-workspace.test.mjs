import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  checkNixWorkspace,
  normalizeWorkspaceDir,
} from "./check-nix-workspace.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeFixture({ omitLeaf = false, stale = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiki-nix-workspace-"));
  fixtures.push(root);

  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n  - apps/*\n",
  );

  const packages = [
    ["packages/core", "@example/core"],
    ["apps/cli", "@example/cli"],
    ["apps/leaf", "@example/leaf"],
  ];
  for (const [dir, name] of packages) {
    const packageDir = join(root, ...dir.split("/"));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name }));
  }

  const selected = omitLeaf
    ? packages.filter(([, name]) => name !== "@example/leaf")
    : packages;
  const paths = selected.map(([dir]) => `        ./${dir}`).join("\n");
  const names = selected.map(([, name]) => `        "${name}"`).join("\n");
  writeFileSync(
    join(root, "flake.nix"),
    `workspacePaths = [\n${paths}${stale ? "\n        ./apps/stale" : ""}\n      ];\nworkspaceNames = [\n${names}${stale ? '\n        "@example/stale"' : ""}\n      ];\n`,
  );

  return root;
}

test("normalizes Windows workspace paths for Nix comparisons", () => {
  assert.equal(normalizeWorkspaceDir(".\\apps\\leaf\\"), "apps/leaf");
});

test("accepts an exact flake workspace projection", () => {
  const result = checkNixWorkspace(writeFixture());
  assert.equal(result.ok, true);
  assert.equal(result.packages.length, 3);
});

test("rejects an omitted leaf workspace package", () => {
  const result = checkNixWorkspace(writeFixture({ omitLeaf: true }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingNames, ["@example/leaf"]);
  assert.deepEqual(result.missingPaths, [
    { name: "@example/leaf", path: "./apps/leaf" },
  ]);
});

test("rejects stale flake workspace entries", () => {
  const result = checkNixWorkspace(writeFixture({ stale: true }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.extraNames, ["@example/stale"]);
  assert.deepEqual(result.extraPaths, ["./apps/stale"]);
});
