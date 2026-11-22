---
mode: shadow
pr_actor: owner_gh
merge_strategy: daemon_verified_rebase
max_autofix_attempts: 2
spend_limit_usd: 1.5
required_checks:
  - pr-title-checker
  - Check flake.nix workspace sync
  - docs-governance
  - lint
  - typecheck
  - build
  - test-gui
protected_paths:
  - APPROVAL_POLICY.md
  - AGENTS.md
  - MAINTAINERS.md
  - .github/workflows/
  - scripts/check-repo-meta.mjs
  - scripts/check-no-comments.mjs
  - scripts/ccp-chaos/check-test-hygiene.mjs
  - pnpm-workspace.yaml
  - flake.nix
always_deny_paths:
  - packages/auth-native/
  - packages/oauth/
  - packages/kap-server/src/auth/
  - apps/kiki-gui/src-tauri/
  - apps/kimi-code/scripts/native/
  - apps/kimi-code/scripts/npm/
  - scripts/release-pipeline.test.mjs
---

# Approval Policy (`X-T-E-R/kiki`)

This policy is read strictly from the protected default branch (`kiki`). Pull requests that modify this file or any listed protected path are marked `policy_changed` and always require human review.

## Rollout Mode

Start in `shadow` mode to calibrate false-approval rates against actual human reviews before enabling `auto_merge_on_green`.

## Approval Rubric

1. **Intent**: Matches the linked issue or verbatim user requirement without scope shrinkage, silent workarounds, or unrequested restriction gates.
2. **Code Quality & Structural Hygiene**:
   - Passes deterministic baseline checks (`pnpm run check:meta`, `scripts/check-no-comments.mjs`, `scripts/ccp-chaos/check-test-hygiene.mjs`, `oxlint --type-aware`, and clean `scripts/test-affected.mjs` or `scripts/run-promote-tests.mjs` candidate receipt).
   - Passes orthogonal semantic Anti-Slop review across active lenses (base-branch reuse, no unauthorized defensive bloat, write-side invariants and lossless error propagation, subtraction-first cleanup, live UI wiring, seamless doc updates, and zero test subversion) with zero blocking findings.
   - Pull request title conforms to `.github/pr-title-checker-config.json` (Conventional Commits) and fills `.github/pull_request_template.md`.
   - Required GitHub Actions checks (including Linux GUI checks) are green on the exact head commit.
3. **Incident Risk**:
   - `low` / `medium`: Eligible under the configured rollout mode once all gates and required CI checks pass and no `protected_paths` or `always_deny_paths` are modified.
   - `high` / `critical` or touching authentication, native crypto, Tauri desktop packaging, release scripts, or protected policy/gate files: Always require manual human review.
