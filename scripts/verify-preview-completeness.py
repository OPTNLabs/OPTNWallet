"""Exercise the preview workflow guards with missing assets and failed jobs.

Uses the same PyYAML and Bash already used by verify-release-completeness.sh.
All synthetic artifacts and CLI manifests stay in an automatically removed
temporary directory. No wallet or network is involved.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import yaml


ROOT = Path(__file__).resolve().parent.parent
BASH = shutil.which("bash")
if BASH is None:
    raise SystemExit("Bash is required to exercise GitHub Actions run steps")


def workflow(name):
    return yaml.safe_load((ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))


def step(job, name):
    return next(item for item in job["steps"] if item.get("name") == name)


def check(body, directory, expected_success, label, environment=None):
    script = directory / "check.sh"
    script.write_text(body, encoding="utf-8", newline="\n")
    result = subprocess.run(
        [BASH, "-e", "-o", "pipefail", "check.sh"],
        cwd=directory,
        env={**os.environ, **(environment or {})},
        capture_output=True,
        text=True,
        timeout=15,
    )
    if (result.returncode == 0) != expected_success:
        raise AssertionError(f"{label}: unexpected exit {result.returncode}\n{result.stdout}\n{result.stderr}")


def verify_assets(job, name, assets):
    body = step(job, name)["run"]
    with tempfile.TemporaryDirectory(prefix="optn-preview-assets-") as temporary:
        directory = Path(temporary)
        for artifact, filename in assets:
            path = directory / "artifacts" / artifact / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic build artifact", encoding="utf-8")
        check(body, directory, True, f"{name}: complete set")
        for artifact, filename in assets:
            path = directory / "artifacts" / artifact / filename
            path.unlink()
            check(body, directory, False, f"{name}: missing {artifact}")
            path.write_text("synthetic build artifact", encoding="utf-8")
    print(f"{name}: complete set accepted; all {len(assets)} individual omissions rejected")


def verify_results(job, name, successful):
    body = step(job, name)["run"]
    with tempfile.TemporaryDirectory(prefix="optn-preview-results-") as temporary:
        directory = Path(temporary)
        check(body, directory, True, name, successful)
        for variable, value in successful.items():
            failures = ("false", "") if value == "true" else ("failure", "cancelled", "skipped", "")
            for failure in failures:
                check(body, directory, False, f"{name}: {variable}={failure}", {**successful, variable: failure})
    print(f"{name}: unsuccessful or absent dependencies rejected")


desktop = workflow("desktop-preview.yml")["jobs"]["preview-complete"]
cli_workflow = workflow("cli-preview.yml")
cli = cli_workflow["jobs"]["complete"]

verify_assets(desktop, "Verify nothing dropped", [
    ("preview-windows-x64-nsis", "wallet.exe"),
    ("preview-windows-x64-msi", "wallet.msi"),
    ("preview-macos-arm64-dmg", "wallet.dmg"),
    ("preview-macos-x64-dmg", "wallet.dmg"),
    *[(f"preview-linux-{architecture}-{kind}", f"wallet.{extension}")
      for architecture in ("x64", "arm64")
      for kind, extension in (("appimage", "AppImage"), ("deb", "deb"), ("rpm", "rpm"), ("flatpak", "flatpak"))],
])
verify_assets(cli, "Verify no target dropped", [
    (f"optn-cli-{label}", "optn.exe" if label == "windows-x64" else "optn")
    for label in ("linux-x64", "linux-arm64", "linux-riscv64", "linux-armv7", "windows-x64", "macos-arm64", "macos-x64")
])
verify_results(desktop, "Require every desktop and Flatpak build to succeed", {
    "DESKTOP_RESULT": "success", "FLATPAK_RESULT": "success",
})
verify_results(cli, "Require every CLI build to succeed", {
    "PROBE_RESULT": "success", "BUILD_RESULT": "success", "CLI_PRESENT": "true",
})

probe = next(item for item in cli_workflow["jobs"]["probe"]["steps"] if item.get("id") == "probe")
with tempfile.TemporaryDirectory(prefix="optn-preview-probe-") as temporary:
    directory = Path(temporary)
    environment = {"GITHUB_OUTPUT": "probe-output.txt"}
    check(probe["run"], directory, False, "missing CLI crate", environment)
    manifest = directory / "crates/optn-cli/Cargo.toml"
    manifest.parent.mkdir(parents=True)
    manifest.write_text('[package]\nname = "synthetic-cli"\n', encoding="utf-8")
    check(probe["run"], directory, True, "present CLI crate", environment)
    if "present=true" not in (directory / "probe-output.txt").read_text(encoding="utf-8"):
        raise AssertionError("CLI probe did not enable its build matrix")
print("CLI deletion fails the probe instead of skipping its build matrix")
