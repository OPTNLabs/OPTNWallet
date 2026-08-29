#!/usr/bin/env bash
#
# Refuse to publish a macOS bundle that cannot launch.
#
# Two failures shipped in v1.7.3 (issue #46), both invisible to a build that
# reported success:
#
#   1. Nested Mach-O binaries with no signature at all. Resources/resources/tor/
#      held tor and libevent-2.1.7.dylib unsigned; on Apple Silicon AMFI
#      SIGKILLs an unsigned binary, so CashFusion's Tor died before it could
#      bootstrap and reported only "exited before finishing bootstrap".
#
#   2. A dependency resolved from the build machine. The main binary linked
#      /opt/homebrew/opt/libusb/lib/libusb-1.0.0.dylib, a path no user has, so
#      the app failed to launch out of the box.
#
# Both are mechanical properties of the built artifact, which is why they belong
# in a gate rather than in a release checklist.
#
# Usage: verify-macos-bundle.sh <path-to-.app>
set -euo pipefail

APP="${1:-}"

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "usage: $0 <path-to-.app>" >&2
  exit 2
fi

for tool in codesign otool file; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool not found; this script only runs on macOS" >&2
    exit 2
  fi
done

# Paths that exist only on a developer's machine. A release binary that names
# one of these is asking every user to have the same Homebrew or MacPorts tree.
FOREIGN_PREFIXES='^(/opt/homebrew|/usr/local/opt|/opt/local)/'

unsigned=()
foreign=()
checked=0

while IFS= read -r -d '' f; do
  file -b "$f" 2>/dev/null | grep -q 'Mach-O' || continue
  checked=$((checked + 1))
  rel="${f#"$APP"/}"

  if ! codesign -dv "$f" >/dev/null 2>&1; then
    unsigned+=("$rel")
  fi

  # Skip the @rpath/@executable_path/@loader_path forms and system libraries;
  # flag anything pointing into a package manager's tree.
  while IFS= read -r dep; do
    if printf '%s' "$dep" | grep -Eq "$FOREIGN_PREFIXES"; then
      foreign+=("$rel -> $dep")
    fi
  done < <(otool -L "$f" 2>/dev/null | tail -n +2 | awk '{print $1}')
done < <(find "$APP" -type f -print0)

echo "Checked $checked Mach-O files in $(basename "$APP")"

status=0

if [ ${#unsigned[@]} -gt 0 ]; then
  status=1
  echo
  echo "UNSIGNED (${#unsigned[@]}) — these are SIGKILLed on Apple Silicon:"
  printf '  %s\n' "${unsigned[@]}"
fi

if [ ${#foreign[@]} -gt 0 ]; then
  status=1
  echo
  echo "BUILD-MACHINE PATHS (${#foreign[@]}) — absent on a user's machine:"
  printf '  %s\n' "${foreign[@]}"
fi

if [ "$checked" -eq 0 ]; then
  # A bundle with no Mach-O in it is not a pass, it is a broken search.
  echo "No Mach-O files found — is '$APP' really an app bundle?" >&2
  exit 1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: every Mach-O is signed and resolves without build-machine paths"
fi

exit "$status"
