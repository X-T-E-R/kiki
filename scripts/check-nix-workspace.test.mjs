import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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

void test("normalizes Windows workspace paths for Nix comparisons", () => {
  assert.equal(normalizeWorkspaceDir(".\\apps\\leaf\\"), "apps/leaf");
});

void test("accepts an exact flake workspace projection", () => {
  const result = checkNixWorkspace(writeFixture());
  assert.equal(result.ok, true);
  assert.equal(result.packages.length, 3);
});

void test("rejects an omitted leaf workspace package", () => {
  const result = checkNixWorkspace(writeFixture({ omitLeaf: true }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingNames, ["@example/leaf"]);
  assert.deepEqual(result.missingPaths, [
    { name: "@example/leaf", path: "./apps/leaf" },
  ]);
});

void test("rejects stale flake workspace entries", () => {
  const result = checkNixWorkspace(writeFixture({ stale: true }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.extraNames, ["@example/stale"]);
  assert.deepEqual(result.extraPaths, ["./apps/stale"]);
});

void test("auth-native Nix source uses the locked Cargo vendor hook and explicit offline build environment", () => {
  const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");
  assert.match(flake, /cargoRoot\s*=\s*"packages\/auth-native"/);
  assert.match(flake, /cargoDeps\s*=\s*pkgs\.rustPlatform\.importCargoLock\s*\{\s*lockFile\s*=\s*\.\/packages\/auth-native\/Cargo\.lock;/);
  for (const input of ["pkgs.cargo", "pkgs.rustc", "pkgs.rustPlatform.cargoSetupHook"]) {
    assert.ok(flake.includes(input));
  }
  assert.ok(flake.includes('export CARGO_HOME="$TMPDIR/kiki-auth-cargo-home"'));
  assert.ok(flake.includes('export CARGO_TARGET_DIR="$TMPDIR/kiki-auth-cargo-target"'));
  assert.ok(flake.includes("export CARGO_NET_OFFLINE=true"));
  const lock = readFileSync(new URL("../packages/auth-native/Cargo.lock", import.meta.url), "utf8");
  const registryPackages = lock.split("[[package]]").filter((entry) => entry.includes("source ="));
  assert.ok(registryPackages.length > 0);
  for (const entry of registryPackages) {
    assert.match(entry, /source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"/);
    assert.match(entry, /checksum = "[0-9a-f]{64}"/);
  }
  assert.doesNotMatch(flake, /cargoHash|allowBuiltinFetchGit|outputHashes/);
});

void test("Node 24 Nix override keeps SQLite bundled with its matching headers", () => {
  const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");
  const overrideStart = flake.indexOf("packaged.overrideAttrs");
  const workspaceStart = flake.indexOf("workspacePaths = [");
  assert.ok(overrideStart >= 0 && workspaceStart > overrideStart);
  const override = flake.slice(overrideStart, workspaceStart);
  assert.match(override, /flag != "--shared-sqlite"/);
  assert.match(override, /hasPrefix "--shared-sqlite-libpath="/);
  assert.match(override, /input != pkgs\.sqlite/);
  assert.match(override, /getDev pkgs\.sqlite/);
  assert.doesNotMatch(override, /--without-sqlite/);
});

void test("Nix build compiles every plugin-sdk export before the GUI bundle", () => {
  const flake = readFileSync(new URL("../flake.nix", import.meta.url), "utf8");
  const buildStart = flake.indexOf("buildPhase = ''");
  const installStart = flake.indexOf("installPhase = ''");
  assert.ok(buildStart >= 0 && installStart > buildStart);
  const buildPhase = flake.slice(buildStart, installStart);
  const sdkBuild = buildPhase.indexOf("pnpm --filter=@kiki/plugin-sdk run build\n");
  const nativeBuild = buildPhase.indexOf("pnpm --filter=@kiki/cli run build:native:sea");
  assert.ok(sdkBuild >= 0 && nativeBuild > sdkBuild);
  assert.equal(buildPhase.indexOf("pnpm --filter=@kiki/plugin-sdk run build"), sdkBuild);
  assert.doesNotMatch(buildPhase, /rollupOptions|plugin-sdk\/dist/);

  const pkg = JSON.parse(
    readFileSync(new URL("../packages/plugin-sdk/package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(pkg.scripts.prepare, "pnpm build");
  assert.equal(pkg.scripts.prepack, "pnpm build");

  const tsconfig = JSON.parse(
    readFileSync(new URL("../packages/plugin-sdk/tsconfig.build.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(tsconfig.include, ["src"]);
  assert.equal(tsconfig.compilerOptions.rootDir, "src");
  assert.equal(tsconfig.compilerOptions.outDir, "dist");
  assert.equal(tsconfig.compilerOptions.module, "NodeNext");

  const emitted = [];
  for (const [key, value] of Object.entries(pkg.exports)) {
    assert.equal(typeof value, "object");
    const stem = key === "." ? "index" : key.slice(2);
    assert.equal(value.default, `./dist/${stem}.js`);
    assert.equal(value.types, `./dist/${stem}.d.ts`);
    assert.equal(
      existsSync(new URL(`../packages/plugin-sdk/src/${stem}.ts`, import.meta.url)),
      true,
      stem,
    );
    emitted.push(`${stem}.js`, `${stem}.d.ts`);
  }
  for (const name of ["media.js", "session-import.js", "media-download.js", "index.js"]) {
    assert.ok(emitted.includes(name));
  }

  const outDir = mkdtempSync(join(tmpdir(), "kiki-plugin-sdk-dist-"));
  fixtures.push(outDir);
  const compiled = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/lib/tsc.js", import.meta.url)),
      "-p",
      fileURLToPath(new URL("../packages/plugin-sdk/tsconfig.build.json", import.meta.url)),
      "--outDir",
      outDir,
      "--rootDir",
      fileURLToPath(new URL("../packages/plugin-sdk/src", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    compiled.status,
    0,
    `${compiled.stdout}\n${compiled.stderr}`,
  );
  for (const name of emitted) {
    const file = join(outDir, name);
    assert.equal(existsSync(file), true, name);
    assert.ok(statSync(file).size > 0, name);
  }
  assert.equal(
    existsSync(join(outDir, "media.js")) &&
      readFileSync(join(outDir, "media.js"), "utf8").includes("mediaKindSchema"),
    true,
  );
  assert.equal(
    readFileSync(join(outDir, "session-import.js"), "utf8").includes("sessionSourceDefinitionSchema"),
    true,
  );
});
