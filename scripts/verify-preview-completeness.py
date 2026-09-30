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
BASH = os.environ.get("BASH") or shutil.which("bash")
if BASH is None:
    raise SystemExit("Bash is required to exercise GitHub Actions run steps")


def workflow(name):
    document = yaml.safe_load((ROOT / ".github/workflows" / name).read_text(encoding="utf-8"))
    # PyYAML's YAML 1.1 loader treats the Actions `on` key as boolean True.
    triggers = document.get("on", document.get(True, {}))
    pull_request = triggers.get("pull_request", {})
    if (not {"dev", "staging", "main"} <= set(pull_request.get("branches", []))
            or "paths" in pull_request or "paths-ignore" in pull_request):
        raise AssertionError(f"{name} must run for every dev/staging/main pull request")
    return document


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
        for event in ("pull_request", "push", "workflow_dispatch"):
            environment = {**successful, "GITHUB_EVENT_NAME": event}
            check(body, directory, True, name, environment)
            for variable, value in successful.items():
                failures = ("false", "") if value == "true" else ("failure", "cancelled", "skipped", "")
                for failure in failures:
                    check(
                        body,
                        directory,
                        False,
                        f"{name} ({event}): {variable}={failure}",
                        {**environment, variable: failure},
                    )
    print(f"{name}: unsuccessful or absent dependencies rejected")


desktop_jobs = workflow("desktop-preview.yml")["jobs"]
desktop = desktop_jobs["preview-complete"]
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

# Matrix removal and conditional uploads must not turn missing platforms green.
for job_id, labels in (
    ("build-desktop-preview", {"windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"}),
    ("flatpak-preview", {"linux-x64", "linux-arm64"}),
):
    job = desktop_jobs[job_id]
    if job.get("if") or job.get("continue-on-error"):
        raise AssertionError(f"{job_id} must not skip PR builds or ignore failures")
    actual = {entry["label"] for entry in job["strategy"]["matrix"]["include"]}
    if not labels <= actual:
        raise AssertionError(f"{job_id}: missing targets {labels - actual}")

for job in (desktop, cli):
    if job.get("if") != "always()":
        raise AssertionError("Completeness jobs must run even after failed/skipped builds")
for name in ("Download every preview artifact", "Verify nothing dropped"):
    if step(desktop, name).get("if"):
        raise AssertionError(f"{name} must also run on pull requests")

for filename, job_id, artifacts in (
    ("android-preview.yml", "debug-apk", {"app-debug-play", "app-debug-fdroid"}),
    ("ios-preview.yml", "build-ios-preview", {"preview-ios-simulator"}),
    ("extension-preview.yml", "build-extension-preview", {"extension-chrome", "extension-firefox"}),
    ("desktop-riscv64.yml", "build", {"desktop-linux-riscv64-unbundled"}),
):
    job = workflow(filename)["jobs"][job_id]
    if job.get("if") or job.get("continue-on-error"):
        raise AssertionError(f"{filename}: required builder may not be skipped or advisory")
    uploads = {item.get("with", {}).get("name"): item for item in job["steps"]
               if "actions/upload-artifact@" in item.get("uses", "")}
    for artifact in artifacts:
        upload = uploads.get(artifact, {})
        if (upload.get("with", {}).get("if-no-files-found") != "error"
                or upload.get("if") or upload.get("continue-on-error")):
            raise AssertionError(f"{filename}: {artifact} requires an unconditional fail-closed upload")
    print(f"{filename}: required artifacts {', '.join(sorted(artifacts))}")

rust_ui = workflow("tauri-rust-ui-mobile.yml")["jobs"]
for job_id, verification in (("desktop", "Verify desktop binary"),
                             ("android", "Verify APK"), ("ios", "Verify iOS simulator app")):
    job = rust_ui[job_id]
    check_step = step(job, verification)
    if any(item.get("if") or item.get("continue-on-error") for item in (job, check_step)):
        raise AssertionError(f"Rust UI {job_id} must build and verify its output")
    print(f"Rust UI {job_id}: compile/output verification (not a published release artifact)")
