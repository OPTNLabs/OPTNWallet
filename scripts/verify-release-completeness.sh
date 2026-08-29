#!/usr/bin/env bash
# Prove the release cannot drop an asset, or gain one nobody expected.
#
# The release asserts its own asset set, but nothing asserted the assertion. A
# pattern with a typo, a rule that silently matches nothing, a guard broad
# enough to accept anything — each looks correct in review and each removes the
# protection entirely.
#
# So this executes the workflow's own shell against a synthetic release built
# from packaging/release-assets.json, then removes one asset at a time and
# requires every removal to be caught. It is the difference between "the check
# is written" and "the check works".
#
# Run it by hand, or let CI do it:  bash scripts/verify-release-completeness.sh
set -uo pipefail

WF=".github/workflows/release.yml"
CONFIG="packaging/release-assets.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

VERSION="1.7.3"
export RELEASE_TAG="v$VERSION"

# Whichever interpreter has PyYAML. CI installs it for python3; a developer
# machine may only have it under `python`, and failing on that would look like
# the check itself is broken.
PY_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import yaml' >/dev/null 2>&1; then
    PY_BIN="$candidate"
    break
  fi
done
if [ -z "$PY_BIN" ]; then
  echo "::error::need Python with PyYAML to read the workflow (pip install pyyaml)"
  exit 2
fi

# Extract the "Assets completeness" step body verbatim.
"$PY_BIN" - "$WF" "$WORK/check.sh" <<'PY'
import io, sys, yaml
workflow = yaml.safe_load(io.open(sys.argv[1], encoding='utf-8'))
step = next(
    s for s in workflow['jobs']['publish']['steps']
    if s.get('name') == 'Assets completeness'
)
body = step['run']
# The CLI block is gated on a job output that does not exist outside Actions;
# substitute the "crate present" case, which is the stricter one.
body = body.replace("${{ needs.cli-probe.outputs.present }}", 'true')
io.open(sys.argv[2], 'w', encoding='utf-8', newline='\n').write(body)
PY

# The full set, from the same config the check reads. Filenames only — a
# pattern like *_amd64.deb needs a concrete name to stand in for it.
"$PY_BIN" - "$CONFIG" "$VERSION" > "$WORK/assets.txt" <<'PY'
import json, sys
# Explicit newline: on Windows print() emits CRLF, and a filename with a
# trailing carriage return matches nothing, which looks exactly like the
# check being broken.
sys.stdout.reconfigure(newline='\n')
version = sys.argv[2]
config = json.load(open(sys.argv[1]))
for asset in config['assets']:
    if not asset.get('required', True):
        continue
    pattern = asset['pattern'].replace('${VERSION}', version)
    # Turn a glob into one concrete filename it matches.
    name = pattern.replace('*', 'x') if pattern.startswith('*') else pattern.replace('*', '')
    if pattern.startswith('*'):
        name = f'OPTNWallet-{version}-1{pattern[1:]}'
    print(name)
PY

mapfile -t ASSETS < "$WORK/assets.txt"

# Everything the workflow runs from the repository root.
REPO="$PWD"
cd "$WORK" || exit 1
mkdir -p packaging
cp "$REPO/$CONFIG" packaging/

populate() {
  rm -rf release-files
  mkdir -p release-files
  for a in "${ASSETS[@]}"; do
    [ "$a" = "${1:-}" ] && continue
    printf 'x' > "release-files/$a"
  done
}

echo "asset set: ${#ASSETS[@]} files, from $CONFIG"
echo

populate
if bash check.sh >/dev/null 2>&1; then
  echo "FULL SET       -> passes"
else
  echo "FULL SET       -> FAILS (the check rejects a complete release)"
  populate
  bash check.sh 2>&1 | grep -E "error|missing|unexpected" | head -10
  exit 1
fi
echo

uncaught=0
for a in "${ASSETS[@]}"; do
  populate "$a"
  if bash check.sh >/dev/null 2>&1; then
    printf '::error::%s could be dropped without the check noticing\n' "$a"
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

# A waiver must be honoured, and must be loud about it.
"$PY_BIN" - <<'PY'
import json
config = json.load(open('packaging/release-assets.json'))
for asset in config['assets']:
    if asset['label'] == 'Firefox extension':
        asset['required'] = False
        asset['reason'] = 'synthetic waiver, exercised by verify-release-completeness.sh'
        break
json.dump(config, open('packaging/release-assets.json', 'w'), indent=2)
PY
populate "OPTNWallet-$VERSION-firefox.zip"
if output="$(bash check.sh 2>&1)"; then
  if printf '%s' "$output" | grep -q 'is waived'; then
    echo "a waived asset is allowed, and says so"
  else
    echo "::error::a waived asset passed silently; a waiver must be visible"
    uncaught=$((uncaught + 1))
  fi
else
  echo "::error::a waived asset was still required"
  uncaught=$((uncaught + 1))
fi

# ...and a waiver with no reason must be refused outright.
"$PY_BIN" - <<'PY'
import json
config = json.load(open('packaging/release-assets.json'))
for asset in config['assets']:
    if asset['label'] == 'Firefox extension':
        asset.pop('reason', None)
        break
json.dump(config, open('packaging/release-assets.json', 'w'), indent=2)
PY
populate
if bash check.sh >/dev/null 2>&1; then
  echo "::error::a waiver with no reason was accepted"
  uncaught=$((uncaught + 1))
else
  echo "a waiver with no reason is refused"
fi

exit "$uncaught"
