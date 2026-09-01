#!/bin/sh
set -eu

repository="${CHROMIUM_BRIDGE_REPOSITORY:-nextster/chromium-bridge}"
ref="${CHROMIUM_BRIDGE_REF:-v0.6.8}"
source_dir="${CHROMIUM_BRIDGE_SOURCE_DIR:-}"
state_dir="${CHROMIUM_BRIDGE_STATE_DIR:-$HOME/.chromium-bridge}"
node_version="24.19.0"
temporary_dir=""
command_name="install"
migration_source=""

main() {
case "${1:-}" in
  install|update|uninstall)
    command_name="$1"
    shift
    ;;
esac

cleanup() {
  if [ -n "$temporary_dir" ] && [ -d "$temporary_dir" ]; then
    rm -rf "$temporary_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ "$(uname -s)" != "Darwin" ] && ! has_argument "--dry-run" "$@"; then
  echo "Chromium Bridge installation currently supports macOS only." >&2
  exit 1
fi

if [ "$command_name" != "uninstall" ] && ! has_argument "--dry-run" "$@"; then
  migrate_legacy_state
fi

require_command curl
require_command tar
node_command="$(find_node || true)"
if [ -z "$node_command" ]; then
  node_command="$(install_portable_node)"
fi

if [ -z "$source_dir" ]; then
  validate_source_part "$repository" "repository"
  validate_source_part "$ref" "ref"
  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/chromium-bridge.XXXXXX")"
  archive="$temporary_dir/source.tar.gz"
  source_dir="$temporary_dir/source"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
    "https://codeload.github.com/$repository/tar.gz/$ref" \
    -o "$archive"
  tar -xzf "$archive" -C "$temporary_dir"
  extracted_root="$(find "$temporary_dir" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [ -z "$extracted_root" ]; then
    echo "Downloaded repository archive is empty." >&2
    exit 1
  fi
  mv "$extracted_root" "$source_dir"
fi

case "$command_name" in
  install|update)
    script="$source_dir/scripts/setup.mjs"
    ;;
  uninstall)
    script="$source_dir/scripts/uninstall.mjs"
    ;;
esac
if [ ! -f "$script" ]; then
  echo "Downloaded source does not contain ${script#"$source_dir/"}." >&2
  exit 1
fi

CHROMIUM_BRIDGE_MIGRATION_SOURCE="$migration_source" \
CHROMIUM_BRIDGE_NODE="$node_command" "$node_command" "$script" "$@"
}

migrate_legacy_state() {
  [ -z "${CHROMIUM_BRIDGE_STATE_DIR:-}" ] || return 0
  legacy_state_dir="$HOME/.chromium-sidecar"
  [ -d "$legacy_state_dir" ] || return 0

  if [ ! -e "$state_dir" ]; then
    mv "$legacy_state_dir" "$state_dir"
    migration_source="$legacy_state_dir"
    return 0
  fi

  if [ -d "$legacy_state_dir/captures" ]; then
    imported_captures="$state_dir/captures/imported-before-rename-$(date +%s)"
    mkdir -p "$imported_captures"
    chmod 700 "$state_dir/captures" "$imported_captures"
    cp -Rp "$legacy_state_dir/captures/." "$imported_captures/"
  fi
  if [ ! -e "$state_dir/node" ] && [ -d "$legacy_state_dir/node" ]; then
    mv "$legacy_state_dir/node" "$state_dir/node"
  fi
  rm -rf "$legacy_state_dir"
  migration_source="$legacy_state_dir"
}

find_node() {
  if [ "${CHROMIUM_BRIDGE_FORCE_PORTABLE_NODE:-0}" != "1" ]; then
    for candidate in "${CHROMIUM_BRIDGE_NODE:-}" "$state_dir/node/bin/node" "$(command -v node 2>/dev/null || true)"; do
      if [ -n "$candidate" ] && [ -x "$candidate" ] && node_is_compatible "$candidate"; then
        printf '%s\n' "$candidate"
        return
      fi
    done
  fi
  return 1
}

node_is_compatible() {
  version="$("$1" --version 2>/dev/null || true)"
  major="$(printf '%s' "$version" | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')"
  [ -n "$major" ] && [ "$major" -ge 20 ]
}

install_portable_node() {
  architecture="$(uname -m)"
  # Official v24.19.0 SHASUMS256.txt values from nodejs.org.
  case "$architecture" in
    arm64)
      node_arch="arm64"
      expected_sha256="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
      ;;
    x86_64)
      node_arch="x64"
      expected_sha256="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316"
      ;;
    *)
      echo "Unsupported Mac architecture: $architecture" >&2
      exit 1
      ;;
  esac

  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  node_stage="$(mktemp -d "$state_dir/.node-install.XXXXXX")"
  node_archive="$node_stage/node.tar.gz"
  archive_name="node-v$node_version-darwin-$node_arch.tar.gz"
  if [ -n "${CHROMIUM_BRIDGE_TEST_NODE_ARCHIVE:-}" ]; then
    cp "$CHROMIUM_BRIDGE_TEST_NODE_ARCHIVE" "$node_archive"
    expected_sha256="${CHROMIUM_BRIDGE_TEST_NODE_SHA256:?Missing test Node SHA-256}"
  else
    echo "Installing verified Node.js v$node_version runtime..." >&2
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
      "https://nodejs.org/dist/v$node_version/$archive_name" \
      -o "$node_archive"
  fi
  actual_sha256="$(file_sha256 "$node_archive")"
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    rm -rf "$node_stage"
    echo "Node.js archive checksum mismatch." >&2
    exit 1
  fi

  tar -xzf "$node_archive" -C "$node_stage"
  extracted="$node_stage/node-v$node_version-darwin-$node_arch"
  if [ ! -x "$extracted/bin/node" ]; then
    rm -rf "$node_stage"
    echo "Node.js archive does not contain an executable runtime." >&2
    exit 1
  fi
  replacement="$state_dir/node.new.$$"
  backup="$state_dir/node.backup.$$"
  rm -rf "$replacement" "$backup"
  mv "$extracted" "$replacement"
  if [ -e "$state_dir/node" ]; then
    mv "$state_dir/node" "$backup"
  fi
  if mv "$replacement" "$state_dir/node"; then
    rm -rf "$backup" "$node_stage"
  else
    [ ! -e "$state_dir/node" ] && [ -e "$backup" ] && mv "$backup" "$state_dir/node"
    rm -rf "$replacement" "$node_stage"
    exit 1
  fi
  printf '%s\n' "$state_dir/node/bin/node"
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "A SHA-256 tool is required." >&2
    exit 1
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Chromium Bridge installer requires $1." >&2
    exit 1
  }
}

validate_source_part() {
  case "$1" in
    ""|*[!A-Za-z0-9._/-]*)
      echo "Invalid $2." >&2
      exit 1
      ;;
  esac
}

has_argument() {
  wanted="$1"
  shift
  for value in "$@"; do
    [ "$value" = "$wanted" ] && return 0
  done
  return 1
}

main "$@"
