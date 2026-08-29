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

  # Compiled references, which is the case the file checks above miss: a
  # dependency can arrive with only its Java classes merged in.
  #
  # Six ML Kit names legitimately remain after the exclusion. They are type
  # references inside io.ionic.libs:ionbarcode-android, the barcode plugin's
  # own jar, naming the classes it would call if the MLKIT backend were
  # selected. This wallet always selects ZXing, so they are never loaded, and
  # none of ML Kit's own code is in the APK. Confirmed by reading that jar,
  # not inferred from the count.
  #
  # Anything beyond these six means ML Kit itself arrived. Listed exactly
  # rather than allowed as a number, because the difference between "a few
  # dangling imports" and "the library is here" is the whole question — the
  # pre-fix APK carried 2,037.
  #
  # grep -a rather than strings: binutils is not guaranteed on a runner, and
  # grep reads the dex as text perfectly well for this.
  expected_refs="$(mktemp)"
  cat > "$expected_refs" <<'EXPECTED'
com/google/mlkit/vision/barcode/BarcodeScanner
com/google/mlkit/vision/barcode/BarcodeScannerOptions
com/google/mlkit/vision/barcode/BarcodeScannerOptions$Builder
com/google/mlkit/vision/barcode/BarcodeScanning
com/google/mlkit/vision/barcode/common/Barcode
com/google/mlkit/vision/common/InputImage
EXPECTED

  dex_names="$(unzip -p "$apk" 'classes*.dex' |
    grep -aoE '(com/google/mlkit|com/google/android/gms/internal/mlkit)[A-Za-z0-9/_$]*' |
    sort -u || true)"
  unexpected="$(printf '%s\n' "$dex_names" | grep -v '^$' |
    grep -Fxv -f "$expected_refs" || true)"
  rm -f "$expected_refs"

  if [ -n "$unexpected" ]; then
    count="$(printf '%s\n' "$unexpected" | grep -c .)"
    echo "::error::$name has $count ML Kit symbol(s) beyond the plugin's own"
    printf '%s\n' "$unexpected" | sed 's/^/    /' | head -30
    if [ "$count" -gt 30 ]; then
      echo "    ... and $((count - 30)) more"
    fi
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
