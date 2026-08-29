#!/usr/bin/env bash
#
# Fail if an APK carries Google's ML Kit barcode scanner.
#
# The barcode plugin declares both backends; the wallet only ever calls ZXing,
# and android/app/build.gradle excludes ML Kit so the proprietary half is not
# shipped. Nothing else notices if that exclusion is dropped: the app keeps
# working, the APK just grows about 20 MB of closed binaries and stops being
# eligible for F-Droid, whose inclusion policy covers dependencies and not only
# the application itself.
#
# Usage: assert-no-proprietary-scanner.sh <apk> [apk...]
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <apk> [apk...]" >&2
  exit 2
fi

status=0

for apk in "$@"; do
  if [ ! -f "$apk" ]; then
    echo "::error::no such APK: $apk"
    status=1
    continue
  fi

  name="$(basename "$apk")"
  echo "::group::$name"
  found=0

  # Packaged files: the native barcode engine, the bundled TensorFlow Lite
  # models, and the Play Services marker each library leaves behind.
  entries="$(unzip -Z1 "$apk")"
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    if matches="$(printf '%s\n' "$entries" | grep -F "$pattern")"; then
      echo "::error::$name contains $pattern"
      printf '%s\n' "$matches" | sed 's/^/    /'
      found=1
    fi
  done <<'PATTERNS'
libbarhopper
mlkit_barcode_models
play-services-mlkit-barcode-scanning.properties
PATTERNS

  # Compiled references. A dependency can arrive without any of the files
  # above if only its Java classes are merged in.
  #
  # Reported with the names it matched, not just a count. "6 references" says
  # nothing about whether a library shipped or a single import is dangling,
  # and the two need opposite responses.
  # grep -a rather than strings: binutils is not guaranteed on every runner,
  # and grep reads the dex as text perfectly well for this.
  dex_names="$(unzip -p "$apk" 'classes*.dex' |
    grep -aoE '(com/google/mlkit|com/google/android/gms/internal/mlkit)[A-Za-z0-9/_$]*' |
    sort -u || true)"
  dex_refs="$(printf '%s' "$dex_names" | grep -c . || true)"
  if [ "$dex_refs" -ne 0 ]; then
    echo "::error::$name has $dex_refs distinct ML Kit symbol(s) in its dex"
    printf '%s
' "$dex_names" | sed 's/^/    /' | head -40
    found=1
  fi

  if [ "$found" -eq 0 ]; then
    echo "  ok       no ML Kit, no Play Services barcode scanner"
  else
    status=1
  fi
  echo '::endgroup::'
done

if [ "$status" -ne 0 ]; then
  echo '::error::a proprietary barcode scanner is back in the build; see' \
    'the exclusion in android/app/build.gradle'
fi
exit "$status"
