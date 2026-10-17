"""Pass a vendored crate's registry-identity audit only on repaired advisories.

    python3 check-vendored-advisories.py <cargo-deny JSON report> <exit status> <ID>...

A vendored, patched crate reaches Cargo as a path package, which advisory
scanners skip. CI therefore audits the original registry crate with the
repository's deny.toml, which ignores nothing, and this script reads that
report (`cargo deny --format json check advisories`, one JSON object per line
on stderr). It passes only when every advisory found is one of the given IDs,
each repaired in the vendored copy and documented in its OPTN.md, so a new
advisory against the crate still fails CI. A scan that failed without naming
any advisory (no database, a broken manifest) fails too, rather than passing
because nothing was reported.
"""

import json
import sys


def main() -> int:
    report, status, repaired = sys.argv[1], int(sys.argv[2]), set(sys.argv[3:])
    found = set()
    with open(report, encoding="utf-8") as lines:
        for line in lines:
            line = line.strip()
            if not line.startswith("{"):
                continue
            entry = json.loads(line)
            if entry.get("type") != "diagnostic":
                continue
            advisory = (entry.get("fields") or {}).get("advisory") or {}
            if advisory.get("id"):
                found.add(advisory["id"])

    unexpected = sorted(found - repaired)
    if unexpected:
        print(
            "::error::advisories the vendored copy does not repair: "
            + ", ".join(unexpected)
        )
        return 1
    if status != 0 and not found:
        print(open(report, encoding="utf-8").read())
        print("::error::cargo deny failed without reporting an advisory")
        return 1
    print(
        "registry advisories, each repaired in the vendored copy: "
        + (", ".join(sorted(found)) or "none")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
