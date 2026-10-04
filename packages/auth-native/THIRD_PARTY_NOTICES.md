# Third-party notices

The advisory-lock holder stamp, persistent lock-file lifecycle and 5-second
heartbeat are adapted from `xai-grok-login/src/manager/lock.rs` in Grok Build.
Copyright 2023–2026 SpaceXAI. Licensed under Apache-2.0; the full license is
included in `licenses/Apache-2.0.txt`. Changes: N-API resource guard, Node timer
waiting instead of Tokio's process-local kernel-wait ticket registry, strict
I/O errors, and cross-platform file-identity checks with `same-file`.

Encryption/decryption directly depend on `age` 0.11.1 (MIT OR Apache-2.0), the
same version and `age::scrypt` envelope used by Codex. No Codex backend is
copied. `fs2` 0.4.3 (MIT OR Apache-2.0) supplies the OS advisory lock; `napi`
and `napi-derive` (MIT) supply N-API, `same-file` (Unlicense OR MIT) checks
file identity, and `zeroize` (Apache-2.0 OR MIT) clears Rust task input buffers.

The build collects the Cargo-locked dependency package licenses into
`licenses/rust/`, with package name/version/license/source URL in
`licenses/rust-dependencies.json`. These notices accompany the native binding
in both npm and SEA assets. Cargo build tooling is not required at runtime.

This package never reads keyring, discovers accounts, interprets tokens or
refreshes OAuth. The caller supplies bytes/passphrase and the actual auth-file
path. JavaScript strings and returned Buffers remain caller-owned; Rust
zeroization is not a promise to erase all V8 copies.
