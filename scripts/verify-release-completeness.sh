#!/usr/bin/env bash
# Prove the release cannot drop an asset, or gain one nobody expected.
#
# The release workflow asserts its own asset set, but nothing asserted the
# assertion. A pattern with a typo, a rule that silently matches nothing, a
# guard broad enough to accept anything — each looks correct in review and
# each removes the protection entirely.
#
# So this executes the workflow's own shell against a synthetic release, then
# removes one asset at a time and requires every removal to be caught. It is
# the difference between "the check is written" and "the check works".
#
# Run it by hand, or let CI do it:  bash scripts/verify-release-completeness.sh
set -uo pipefail

WF=".github/workflows/release.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

VERSION="1.7.3"
export RELEASE_TAG="v$VERSION"

# Extract the "Verify the published set is complete" step body verbatim.
python - "$WF" "$WORK/check.sh" <<'PY'
import io, re, sys, yaml
workflow = yaml.safe_load(io.open(sys.argv[1], encoding='utf-8'))
step = next(
    s for s in workflow['jobs']['publish']['steps']
    if s.get('name') == 'Verify the published set is complete'
)
body = step['run']
# The CLI block is gated on a job output that does not exist outside Actions;
# substitute the "crate present" case, which is the stricter one.
body = body.replace('${{ needs.cli-probe.outputs.present }}', 'true')
io.open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write(body)
PY

# The full set, exactly as the release publishes it.
ASSETS=(
  "OPTNWallet-$VERSION-windows-x64-setup.exe"
  "OPTNWallet-$VERSION-windows-x64.msi"
  "OPTNWallet-$VERSION-macos-arm64.dmg"
  "OPTNWallet-$VERSION-macos-x64.dmg"
  "OPTNWallet-$VERSION-macos-arm64.app.zip"
  "OPTNWallet-$VERSION-macos-x64.app.zip"
  "OPTNWallet-$VERSION-linux-x64.AppImage"
  "OPTNWallet-$VERSION-linux-arm64.AppImage"
  "OPTNWallet-$VERSION-linux-riscv64-unbundled"
  "OPTNWallet-$VERSION-linux-x64.flatpak"
  "OPTNWallet-$VERSION-linux-arm64.flatpak"
  "OPTNWallet_${VERSION}_amd64.deb"
  "OPTNWallet_${VERSION}_arm64.deb"
  "OPTNWallet-$VERSION-1.x86_64.rpm"
  "OPTNWallet-$VERSION-1.aarch64.rpm"
  "OPTNWallet-$VERSION-android-fdroid.apk"
  "OPTNWallet-$VERSION-android-play.apk"
  "OPTNWallet-$VERSION-android.aab"
  "OPTNWallet-$VERSION-ios-simulator.zip"
  "OPTNWallet-$VERSION-chrome.zip"
  "OPTNWallet-$VERSION-firefox.zip"
  "optn-$VERSION-linux-x64"
  "optn-$VERSION-linux-arm64"
  "optn-$VERSION-linux-riscv64"
  "optn-$VERSION-linux-armv7"
  "optn-$VERSION-macos-arm64"
  "optn-$VERSION-macos-x64"
  "optn-$VERSION-windows-x64.exe"
)

populate() {
  rm -rf release-files
  mkdir -p release-files
  for a in "${ASSETS[@]}"; do
    [ "$a" = "${1:-}" ] && continue
    printf 'x' > "release-files/$a"
  done
}

cd "$WORK" || exit 1
echo "asset set: ${#ASSETS[@]} files"
echo

populate
if bash check.sh >/dev/null 2>&1; then
  echo "FULL SET       -> passes"
else
  echo "FULL SET       -> FAILS (the check rejects a complete release)"
  populate; bash check.sh 2>&1 | grep -E "error|missing|unexpected" | head -10
  exit 1
fi
echo

uncaught=0
for a in "${ASSETS[@]}"; do
  populate "$a"
  if bash check.sh >/dev/null 2>&1; then
    printf '  NOT CAUGHT   %s\n' "$a"
    uncaught=$((uncaught + 1))
  fi
done

if [ "$uncaught" -eq 0 ]; then
  echo "every one of the ${#ASSETS[@]} assets is caught when removed"
else
  echo "::error::$uncaught asset(s) are not actually protected"
fi

# And an asset nobody accounted for must be rejected too.
populate
printf 'x' > "release-files/OPTNWallet-$VERSION-surprise.tar.gz"
if bash check.sh >/dev/null 2>&1; then
  echo "::error::an unexpected asset is not rejected; the guard accepts anything"
  uncaught=$((uncaught + 1))
else
  echo "an unexpected asset is rejected"
fi

exit "$uncaught"
