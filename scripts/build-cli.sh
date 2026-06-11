#!/usr/bin/env bash
# Builds self-contained `gardens` CLI binaries (no Bun install needed to run)
# into dist/cli/gardens-<target> for the four release targets, then smoke-tests
# the binary matching the build machine.
#
# Usage: scripts/build-cli.sh
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
root_dir=$(dirname "$script_dir")
out_dir="$root_dir/dist/cli"
entry="$root_dir/apps/cli/src/index.ts"

mkdir -p "$out_dir"

targets="bun-linux-x64 bun-linux-arm64 bun-darwin-x64 bun-darwin-arm64"
for target in $targets; do
  out="$out_dir/gardens-$target"
  echo "==> $out"
  bun build --compile --target="$target" "$entry" --outfile "$out"
done

# Verify the native-platform binary actually runs.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) native="gardens-bun-darwin-arm64" ;;
  Darwin-x86_64) native="gardens-bun-darwin-x64" ;;
  Linux-aarch64 | Linux-arm64) native="gardens-bun-linux-arm64" ;;
  Linux-x86_64) native="gardens-bun-linux-x64" ;;
  *) native="" ;;
esac

if [ -n "$native" ]; then
  echo "==> smoke test: $native --version"
  "$out_dir/$native" --version
else
  echo "warning: unrecognized platform $(uname -s)-$(uname -m); skipping smoke test" >&2
fi

echo "done — binaries in dist/cli/"
