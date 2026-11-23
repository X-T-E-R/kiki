#!/bin/sh
set -eu

TMP_DIR=""
STAGE_PATH=""

die() {
  printf 'kiki install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "${STAGE_PATH:-}" ] && [ -e "$STAGE_PATH" ]; then
    rm -f "$STAGE_PATH"
  fi
  if [ -n "${TMP_DIR:-}" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

usage() {
  cat <<'EOF'
Usage: install.sh [OPTIONS]

Install the standalone Kiki CLI binary (Linux/macOS, no Node.js or sudo required).

Options:
  --channel <stable|beta>   Release channel (default: stable, env: KIKI_CHANNEL)
  --version <ver|tag>       Pin version or tag, e.g. 0.6.0 or kiki-v0.6.0-beta.1
  --repo <owner/repo>       GitHub repository (default: X-T-E-R/kiki, env: KIKI_GITHUB_REPO)
  --base-url <url>          Pinned download root URL (env: KIKI_DOWNLOAD_BASE_URL)
  --install-dir <dir>       Install directory (default: $HOME/.local/bin, env: KIKI_INSTALL_DIR)
  --apply <source>          Hydrate a space after install (repeatable)
  --override                Pass --override to kiki space apply
  --home <dir>              Pass --home <dir> to kiki space apply
  -y, --yes                 Skip confirmation prompts (default for --apply)
  -h, --help                Show this help message
EOF
}

detect_binary() {
  os="$(uname -s 2>/dev/null || printf 'unknown')"
  arch="$(uname -m 2>/dev/null || printf 'unknown')"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64)   printf 'kiki-linux-x64\n' ;;
        aarch64|arm64)  printf 'kiki-linux-arm64\n' ;;
        *) die "unsupported platform: $os $arch (supported: Linux/macOS x86_64/arm64)" ;;
      esac
      ;;
    Darwin)
      case "$arch" in
        arm64|aarch64)  printf 'kiki-darwin-arm64\n' ;;
        x86_64|amd64)   printf 'kiki-darwin-x64\n' ;;
        *) die "unsupported platform: $os $arch (supported: Linux/macOS x86_64/arm64)" ;;
      esac
      ;;
    *)
      die "unsupported platform: $os $arch (supported: Linux/macOS x86_64/arm64)"
      ;;
  esac
}

normalize_tag() {
  raw="$1"
  case "$raw" in
    kiki-v*) tag="$raw" ;;
    v*)      tag="kiki-$raw" ;;
    *)       tag="kiki-v$raw" ;;
  esac
  if ! printf '%s\n' "$tag" | grep -Eq '^kiki-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
    die "invalid version or tag: $raw"
  fi
  printf '%s\n' "$tag"
}

validate_repo() {
  if ! printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    die "invalid --repo value: $1 (expected owner/repo)"
  fi
}

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=15 -O "$dest" "$url"
  else
    die "either curl or wget is required to download Kiki"
  fi
}

fetch_releases_json() {
  url="$1"
  dest="$2"
  token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if command -v curl >/dev/null 2>&1; then
    if [ -n "$token" ]; then
      curl -fsSL --retry 2 --connect-timeout 15 \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        -H "Authorization: Bearer $token" \
        -o "$dest" "$url"
    else
      curl -fsSL --retry 2 --connect-timeout 15 \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        -o "$dest" "$url"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "$token" ]; then
      wget -q --tries=3 --timeout=15 \
        --header="Accept: application/vnd.github+json" \
        --header="X-GitHub-Api-Version: 2022-11-28" \
        --header="Authorization: Bearer $token" \
        -O "$dest" "$url"
    else
      wget -q --tries=3 --timeout=15 \
        --header="Accept: application/vnd.github+json" \
        --header="X-GitHub-Api-Version: 2022-11-28" \
        -O "$dest" "$url"
    fi
  else
    die "either curl or wget is required to query GitHub Releases"
  fi
}

parse_release_tag() {
  target_channel="$1"
  releases_file="$2"
  awk -v channel="$target_channel" '
    BEGIN {
      in_str = 0; esc = 0; obj = 0; arr = 0; items = 0; found = 0;
      expect = ""; cur_key = ""; str_buf = ""; raw_val = "";
      tag = ""; draft = ""; prerelease = "";
    }
    {
      line = $0
      n = length(line)
      for (i = 1; i <= n; i++) {
        c = substr(line, i, 1)
        if (in_str) {
          if (esc) {
            if (arr == 1 && obj == 1 && (expect == "key" || (expect == "val" && cur_key == "tag_name"))) {
              str_buf = str_buf c
            }
            esc = 0
          } else if (c == "\\") {
            esc = 1
          } else if (c == "\"") {
            in_str = 0
            if (arr == 1 && obj == 1) {
              if (expect == "key") {
                cur_key = str_buf
                expect = "colon"
              } else if (expect == "val") {
                if (cur_key == "tag_name") tag = str_buf
                cur_key = ""
                expect = "comma"
              }
            }
            str_buf = ""
          } else {
            if (arr == 1 && obj == 1 && (expect == "key" || (expect == "val" && cur_key == "tag_name"))) {
              str_buf = str_buf c
            }
          }
          continue
        }

        if (c == "\"") {
          in_str = 1
          str_buf = ""
          continue
        }

        if (arr == 1 && obj == 1 && expect == "val") {
          if (c ~ /[A-Za-z0-9._+-]/) {
            raw_val = raw_val c
            continue
          }
          if (raw_val != "") {
            if (cur_key == "draft") draft = raw_val
            else if (cur_key == "prerelease") prerelease = raw_val
            raw_val = ""
            cur_key = ""
            expect = "comma"
          }
        }

        if (c == "[") {
          if (arr == 1 && obj == 1 && expect == "val") {
            cur_key = ""
            expect = "comma"
          }
          arr++
        } else if (c == "]") {
          if (arr > 0) arr--
        } else if (c == "{") {
          if (arr == 1 && obj == 0) {
            items++
            tag = ""; draft = ""; prerelease = "";
            cur_key = ""; raw_val = ""; expect = "key"
          } else if (arr == 1 && obj == 1 && expect == "val") {
            cur_key = ""
            expect = "comma"
          }
          obj++
        } else if (c == "}") {
          if (arr == 1 && obj == 1) {
            if (substr(tag, 1, 6) == "kiki-v" && draft == "false") {
              if (channel == "beta" || prerelease == "false") {
                found = 1
                print "FOUND:" tag
                exit 0
              }
            }
          }
          if (obj > 0) obj--
        } else if (arr == 1 && obj == 1) {
          if (c == ":" && expect == "colon") {
            expect = "val"
            raw_val = ""
          } else if (c == ",") {
            expect = "key"
            cur_key = ""
            raw_val = ""
          }
        }
      }
    }
    END {
      if (!found) print "COUNT:" items
    }
  ' "$releases_file"
}

resolve_tag_via_api() {
  api_base="$1"
  repo="$2"
  channel="$3"
  releases_json="$TMP_DIR/releases.json"
  page=1
  while :; do
    api_url="${api_base%/}/repos/${repo}/releases?per_page=100&page=${page}"
    fetch_releases_json "$api_url" "$releases_json" || die "failed to query GitHub Releases API: $api_url"
    parsed="$(parse_release_tag "$channel" "$releases_json")"
    case "$parsed" in
      FOUND:*)
        printf '%s\n' "${parsed#FOUND:}"
        return 0
        ;;
      COUNT:0|'')
        die "no matching $channel kiki-v* release found in $repo"
        ;;
    esac
    page=$((page + 1))
  done
}

extract_expected_sha256() {
  sha_file="$1"
  digest="$(awk 'NF > 0 { sub(/\r$/, "", $1); print $1; exit }' "$sha_file" | tr 'A-F' 'a-f')"
  case "$digest" in
    *[!0-9a-f]*|'')
      die "invalid SHA-256 checksum in downloaded .sha256 file"
      ;;
  esac
  if [ "${#digest}" -ne 64 ]; then
    die "invalid SHA-256 checksum length in downloaded .sha256 file"
  fi
  printf '%s\n' "$digest"
}

compute_sha256() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}' | tr 'A-F' 'a-f'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}' | tr 'A-F' 'a-f'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}' | tr 'A-F' 'a-f'
  else
    die "no SHA-256 tool found (tried sha256sum, shasum, openssl)"
  fi
}

download_release_pair() {
  root_url="$1"
  binary="$2"
  bin_dest="$3"
  sha_dest="$4"
  download_file "${root_url%/}/${binary}" "$bin_dest" &&
    download_file "${root_url%/}/${binary}.sha256" "$sha_dest"
}

main() {
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM
  trap 'cleanup; exit 129' HUP

  channel="${KIKI_CHANNEL:-stable}"
  version="${KIKI_VERSION:-}"
  repo="${KIKI_GITHUB_REPO:-X-T-E-R/kiki}"
  base_url="${KIKI_DOWNLOAD_BASE_URL:-}"
  install_dir="${KIKI_INSTALL_DIR:-}"
  github_web_url="${KIKI_GITHUB_WEB_URL:-https://github.com}"
  github_api_url="${KIKI_GITHUB_API_URL:-https://api.github.com}"
  apply_override=0
  apply_home=""
  apply_count=0

  remaining=$#
  while [ "$remaining" -gt 0 ]; do
    arg="$1"
    shift
    remaining=$((remaining - 1))
    case "$arg" in
      --channel)
        [ "$remaining" -gt 0 ] || die "--channel requires a value (stable or beta)"
        channel="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --channel=*)
        channel="${arg#--channel=}"
        ;;
      --version)
        [ "$remaining" -gt 0 ] || die "--version requires a value"
        version="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --version=*)
        version="${arg#--version=}"
        ;;
      --repo)
        [ "$remaining" -gt 0 ] || die "--repo requires an <owner/repo> value"
        repo="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --repo=*)
        repo="${arg#--repo=}"
        ;;
      --base-url)
        [ "$remaining" -gt 0 ] || die "--base-url requires a URL"
        base_url="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --base-url=*)
        base_url="${arg#--base-url=}"
        ;;
      --install-dir)
        [ "$remaining" -gt 0 ] || die "--install-dir requires a directory path"
        install_dir="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --install-dir=*)
        install_dir="${arg#--install-dir=}"
        ;;
      --apply)
        [ "$remaining" -gt 0 ] || die "--apply requires a source path or reference"
        [ -n "$1" ] || die "--apply requires a non-empty source"
        set -- "$@" "$1"
        shift
        remaining=$((remaining - 1))
        apply_count=$((apply_count + 1))
        ;;
      --apply=*)
        val="${arg#--apply=}"
        [ -n "$val" ] || die "--apply requires a non-empty source"
        set -- "$@" "$val"
        apply_count=$((apply_count + 1))
        ;;
      --override)
        apply_override=1
        ;;
      --home)
        [ "$remaining" -gt 0 ] || die "--home requires a directory path"
        apply_home="$1"
        shift
        remaining=$((remaining - 1))
        ;;
      --home=*)
        apply_home="${arg#--home=}"
        ;;
      -y|--yes)
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $arg (run with --help for usage)"
        ;;
    esac
  done

  case "$channel" in
    stable|beta) ;;
    *) die "unsupported --channel: $channel (expected stable or beta)" ;;
  esac

  validate_repo "$repo"

  if [ -z "$install_dir" ]; then
    if [ -z "${HOME:-}" ]; then
      die "HOME is not set; pass --install-dir <dir>"
    fi
    install_dir="${HOME%/}/.local/bin"
  fi

  binary="$(detect_binary)"

  tmp_root="${TMPDIR:-/tmp}"
  mkdir -p "$tmp_root"
  TMP_DIR="$(mktemp -d "${tmp_root%/}/kiki-install.XXXXXX")"
  chmod 700 "$TMP_DIR"

  bin_tmp="$TMP_DIR/$binary"
  sha_tmp="$TMP_DIR/$binary.sha256"

  if [ -n "$base_url" ]; then
    download_release_pair "$base_url" "$binary" "$bin_tmp" "$sha_tmp" ||
      die "failed to download $binary and checksum from $base_url"
  elif [ -n "$version" ]; then
    tag="$(normalize_tag "$version")"
    release_root="${github_web_url%/}/${repo}/releases/download/${tag}"
    download_release_pair "$release_root" "$binary" "$bin_tmp" "$sha_tmp" ||
      die "failed to download $binary for tag $tag from $release_root"
  elif [ "$channel" = "stable" ]; then
    latest_root="${github_web_url%/}/${repo}/releases/latest/download"
    if ! download_release_pair "$latest_root" "$binary" "$bin_tmp" "$sha_tmp"; then
      tag="$(resolve_tag_via_api "$github_api_url" "$repo" "stable")"
      release_root="${github_web_url%/}/${repo}/releases/download/${tag}"
      download_release_pair "$release_root" "$binary" "$bin_tmp" "$sha_tmp" ||
        die "failed to download $binary for tag $tag from $release_root"
    fi
  else
    tag="$(resolve_tag_via_api "$github_api_url" "$repo" "beta")"
    release_root="${github_web_url%/}/${repo}/releases/download/${tag}"
    download_release_pair "$release_root" "$binary" "$bin_tmp" "$sha_tmp" ||
      die "failed to download $binary for tag $tag from $release_root"
  fi

  expected_sha="$(extract_expected_sha256 "$sha_tmp")"
  actual_sha="$(compute_sha256 "$bin_tmp")"
  if [ "$actual_sha" != "$expected_sha" ]; then
    die "SHA-256 verification failed for $binary (expected $expected_sha, got $actual_sha)"
  fi

  mkdir -p "$install_dir"
  STAGE_PATH="${install_dir%/}/.kiki.tmp.$$"
  cp "$bin_tmp" "$STAGE_PATH"
  chmod 0755 "$STAGE_PATH"
  mv -f "$STAGE_PATH" "${install_dir%/}/kiki"
  STAGE_PATH=""

  kiki_bin="${install_dir%/}/kiki"
  in_path=0
  case ":${PATH:-}:" in
    *":${install_dir%/}:"*) in_path=1 ;;
  esac
  PATH="${install_dir%/}:${PATH:-}"
  export PATH

  installed_version="$("$kiki_bin" --version)" || die "installed binary failed verification: $kiki_bin --version"
  printf 'Installed %s -> %s\n' "$installed_version" "$kiki_bin"
  if [ "$in_path" -eq 0 ]; then
    printf 'Add to PATH: export PATH="%s:$PATH"\n' "${install_dir%/}"
  fi

  if [ "$apply_count" -gt 0 ]; then
    if [ "$apply_override" -eq 1 ]; then
      set -- "$@" --override
    fi
    if [ -n "$apply_home" ]; then
      set -- "$@" --home "$apply_home"
    fi
    set -- "$@" --yes
    "$kiki_bin" space apply "$@"
  fi
}

main "$@"
