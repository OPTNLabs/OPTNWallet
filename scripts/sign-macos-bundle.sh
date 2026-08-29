#!/usr/bin/env bash
#
# Sign every Mach-O inside a macOS .app, innermost first.
#
# Tauri signs the app bundle, and `codesign --deep` signs what it recognises as
# nested code: frameworks, XPC services, helper apps. It does not sign a loose
# executable dropped into Resources/, because that is not a bundle structure it
# knows how to walk. The Tor subprocess and its libevent dylib are exactly that,
# and they shipped in v1.7.3 with no signature at all.
#
# On Apple Silicon an unsigned Mach-O is not merely untrusted — AMFI refuses to
# execute it and the kernel kills the process with SIGKILL. That is why Tor
# exited before bootstrapping instead of reporting an error: it never ran.
#
# Signing has to go innermost first. Signing a container seals a hash of what it
# contains, so signing the app and then touching a binary inside it invalidates
# the outer signature.
#
# Usage: sign-macos-bundle.sh <path-to-.app> [identity]
#   identity defaults to "-", ad-hoc, which is what unsigned builds use and is
#   enough to satisfy AMFI. A real Developer ID is passed through unchanged.
set -euo pipefail

APP="${1:-}"
IDENTITY="${2:--}"

if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "usage: $0 <path-to-.app> [identity]" >&2
  exit 2
fi

if ! command -v codesign >/dev/null 2>&1; then
  echo "codesign not found; this script only runs on macOS" >&2
  exit 2
fi

# Every Mach-O in the bundle, deepest path first so containers are sealed after
# their contents. `file` is the reliable test: a Tor binary has no extension and
# a dylib may not be marked executable.
mach_o_files() {
  find "$APP" -type f -print0 \
    | while IFS= read -r -d '' f; do
        if file -b "$f" 2>/dev/null | grep -q 'Mach-O'; then
          printf '%s\n' "$f"
        fi
      done \
    | awk '{ print gsub(/\//, "/") "\t" $0 }' \
    | sort -rn \
    | cut -f2-
}

signed=0
while IFS= read -r binary; do
  # The main executable is sealed by the bundle signature applied last.
  case "$binary" in
    "$APP/Contents/MacOS/"*) continue ;;
  esac
  echo "  signing $(printf '%s' "$binary" | sed "s|^$APP/||")"
  # --timestamp=none: an ad-hoc signature cannot carry a trusted timestamp, and
  # asking for one makes the call fail on a runner with no network path to
  # Apple's timestamp service.
  codesign --force --timestamp=none --sign "$IDENTITY" "$binary"
  signed=$((signed + 1))
done < <(mach_o_files)

echo "  signed $signed nested binaries"

# The bundle last, so it seals everything above.
echo "  signing bundle $(basename "$APP")"
codesign --force --timestamp=none --sign "$IDENTITY" "$APP"

echo "done"
