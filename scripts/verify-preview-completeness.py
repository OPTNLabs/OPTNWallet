"""Exercise the preview workflow guards with missing assets and failed jobs.

Uses the same PyYAML and Bash already used by verify-release-completeness.sh.
All synthetic artifacts and CLI manifests stay in an automatically removed
temporary directory. No wallet or network is involved.
"""

import os
import hashlib
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


def verify_assets(job, name, assets, provenance_artifact=None):
    body = step(job, name)["run"]
    assets = list(assets)
    if provenance_artifact:
        assets.extend((provenance_artifact, filename) for filename in ("build-info.txt", "SHA256SUMS"))
    with tempfile.TemporaryDirectory(prefix="optn-preview-assets-") as temporary:
        directory = Path(temporary)
        for artifact, filename in assets:
            path = directory / "artifacts" / artifact / filename
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic build artifact", encoding="utf-8")
        if provenance_artifact:
            provenance = directory / "artifacts" / provenance_artifact
            (provenance / "build-info.txt").write_text(
                f"checkout_sha={'a' * 40}\npr_head_sha={'b' * 40}\ninterface=Rust Leptos\n",
                encoding="utf-8", newline="\n",
            )
            (provenance / "SHA256SUMS").write_text(
                "".join(f"{hashlib.sha256((provenance / filename).read_bytes()).hexdigest()}  {filename}\n"
                        for filename in ("wallet.dmg", "build-info.txt")),
                encoding="utf-8", newline="\n",
            )
        check(body, directory, True, f"{name}: complete set")
        for artifact, filename in assets:
            path = directory / "artifacts" / artifact / filename
            contents = path.read_bytes()
            path.unlink()
            check(body, directory, False, f"{name}: missing {artifact}/{filename}")
            path.write_bytes(contents)
        if provenance_artifact:
            for filename in ("wallet.dmg", "build-info.txt", "SHA256SUMS"):
                path = provenance / filename
                contents = path.read_bytes()
                path.write_bytes(contents + b"tampered\n")
                check(body, directory, False, f"{name}: tampered {filename}")
                path.write_bytes(contents)
            check(body, directory, True, f"{name}: restored provenance")
            print(f"{name}: disk image, revision manifest and checksum tampering rejected")
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
    ("preview-macos-arm64-leptos-dmg", "wallet.dmg"),
    *[(f"preview-linux-{architecture}-{kind}", f"wallet.{extension}")
      for architecture in ("x64", "arm64")
      for kind, extension in (("appimage", "AppImage"), ("deb", "deb"), ("rpm", "rpm"), ("flatpak", "flatpak"))],
], provenance_artifact="preview-macos-arm64-leptos-dmg")
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

android = workflow("tauri-rust-ui-mobile.yml")["jobs"]["android"]
with tempfile.TemporaryDirectory(prefix="optn-rust-apk-") as temporary:
    directory = Path(temporary)
    body = step(android, "Verify APK")["run"]
    environment = {"GITHUB_SHA": "fixture-merge", "PR_HEAD_SHA": "fixture-head"}
    apk = directory / "src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk"
    apk.parent.mkdir(parents=True)
    check(body, directory, False, "missing Rust APK", environment)
    apk.write_bytes(b"")
    check(body, directory, False, "empty Rust APK", environment)
    apk.write_bytes(b"synthetic Rust APK")
    check(body, directory, True, "one Rust APK", environment)
    artifact = directory / "artifacts/optn-leptos-android-aarch64-debug.apk"
    assert artifact.read_bytes() == apk.read_bytes()
    assert hashlib.sha256(artifact.read_bytes()).hexdigest() in (directory / "artifacts/SHA256SUMS").read_text()
    assert "pr_head_sha=fixture-head" in (directory / "artifacts/build-info.txt").read_text()
    extra = apk.with_name("extra-debug.apk")
    extra.write_bytes(b"unexpected duplicate")
    check(body, directory, False, "ambiguous Rust APK set", environment)
print("Rust APK delivery rejects missing, empty and ambiguous builds; preserves checksum and revision")
