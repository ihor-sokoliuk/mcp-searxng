#!/usr/bin/env bash
# Recompute npmDepsHash in flake.nix for the current package-lock.json.
# Usage: ./scripts/update-flake-hash.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v nix >/dev/null 2>&1; then
  echo "nix is required" >&2
  exit 1
fi

# Temporarily use a fake hash to force a mismatch that reports the correct value.
cp flake.nix /tmp/flake.nix.bak
sed -i 's/npmDepsHash = "sha256-[^"]*";/npmDepsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";/' flake.nix

got=""
if output=$(nix build .#default 2>&1); then
  echo "build succeeded unexpectedly; restoring flake.nix" >&2
  cp /tmp/flake.nix.bak flake.nix
  exit 0
else
  got=$(printf '%s\n' "$output" | sed -n 's/.*got:    //p' | head -n1)
fi

cp /tmp/flake.nix.bak flake.nix

if [[ -z "$got" ]]; then
  echo "could not determine correct hash" >&2
  echo "$output" >&2
  exit 1
fi

sed -i "s/npmDepsHash = \"sha256-[^\"]*\";/npmDepsHash = \"$got\";/" flake.nix
echo "updated npmDepsHash to $got"
