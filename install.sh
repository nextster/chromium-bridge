#!/bin/sh
set -eu

repository="${CHROMIUM_SIDECAR_REPOSITORY:-nextster/chromium-sidecar}"
ref="${CHROMIUM_SIDECAR_REF:-main}"
source_dir="${CHROMIUM_SIDECAR_SOURCE_DIR:-}"
temporary_dir=""

cleanup() {
  if [ -n "$temporary_dir" ] && [ -d "$temporary_dir" ]; then
    rm -rf "$temporary_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "$source_dir" ]; then
  command -v curl >/dev/null 2>&1 || {
    echo "Chromium Sidecar installer requires curl." >&2
    exit 1
  }
  command -v tar >/dev/null 2>&1 || {
    echo "Chromium Sidecar installer requires tar." >&2
    exit 1
  }
  case "$repository" in
    *[!A-Za-z0-9._/-]*)
      echo "Invalid repository." >&2
      exit 1
      ;;
  esac
  case "$ref" in
    *[!A-Za-z0-9._/-]*)
      echo "Invalid ref." >&2
      exit 1
      ;;
  esac

  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/chromium-sidecar.XXXXXX")"
  archive="$temporary_dir/source.tar.gz"
  source_dir="$temporary_dir/source"
  mkdir -p "$source_dir"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 \
    "https://codeload.github.com/$repository/tar.gz/$ref" \
    -o "$archive"
  tar -xzf "$archive" -C "$source_dir" --strip-components=1
fi

setup="$source_dir/scripts/setup.mjs"
if [ ! -f "$setup" ]; then
  echo "Downloaded source does not contain scripts/setup.mjs." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || {
  echo "Chromium Sidecar requires Node.js 20 or newer: https://nodejs.org/" >&2
  exit 1
}

node "$setup" "$@"
