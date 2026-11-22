---
mode: auto_merge_on_green
pr_actor: owner_gh
merge_strategy: daemon_verified_rebase
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
  - ./AGENTS.md
  - MAINTAINERS.md
  - .github/workflows/
  - scripts/check-repo-meta.mjs
  - scripts/check-no-comments.mjs
  - scripts/ccp-chaos/check-test-hygiene.mjs
  - pnpm-workspace.yaml
  - flake.nix
  - packages/auth-native/
  - packages/oauth/
  - packages/kap-server/src/auth/
  - apps/kiki-gui/src-tauri/
  - scripts/release-pipeline.test.mjs
always_deny_paths:
  - apps/kimi-code/scripts/native/
  - apps/kimi-code/scripts/npm/
---

# Approval Policy (`X-T-E-R/kiki`)

This policy is read strictly from the protected default branch (`kiki`). Pull requests that modify this file or any listed `protected_paths` undergo head-bound Jev semantic review, with unresolved holds escalated to the Kiki project lead maintainer before merging; `always_deny_paths` cover external native/npm release publishing scripts and always require manual human review.

## Rollout Mode

`auto_merge_on_green`: eligible pull requests auto-merge once deterministic checks, semantic Anti-Slop review, and required GitHub Actions checks are green on the exact head commit and no `protected_paths` or `always_deny_paths` require manual escalation.

## Approval Rubric

1. **Intent**: Matches the linked issue or verbatim user requirement without scope shrinkage, silent workarounds, or unrequested restriction gates.
2. **Code Quality & Structural Hygiene**:
   - Passes deterministic baseline checks (`pnpm run check:meta`, `scripts/check-no-comments.mjs`, `scripts/ccp-chaos/check-test-hygiene.mjs`, `oxlint --type-aware`, and clean `scripts/test-affected.mjs` or `scripts/run-promote-tests.mjs` candidate receipt).
   - Passes orthogonal semantic Anti-Slop review across active lenses (base-branch reuse, no unauthorized defensive bloat, write-side invariants and lossless error propagation, subtraction-first cleanup, live UI wiring, seamless doc updates, and zero test subversion) with zero blocking findings.
   - Pull request title conforms to `.github/pr-title-checker-config.json` (Conventional Commits) and fills `.github/pull_request_template.md`.
   - Required GitHub Actions checks (including Linux GUI checks) are green on the exact head commit.
3. **Escalation Boundaries**:
   - Changes touching `protected_paths` (root policy/governance files, authentication, native crypto, Tauri desktop packaging, or release pipeline tests) undergo head-bound Jev semantic review and escalate unresolved holds to the Kiki project lead maintainer before merging.
   - Changes touching `always_deny_paths` (`apps/kimi-code/scripts/native/`, `apps/kimi-code/scripts/npm/`) always require manual human review.
