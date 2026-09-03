mod parity;

use std::{
    env, fs,
    path::{Path, PathBuf},
};

const FRAMEWORK_NAMES: &[&str] = &["leptos", "tauri", "dioxus", "capacitor"];

/// Apple/Swift packages that may only be reached through a platform provider.
///
/// The 58 Opals stack is an optional Apple-native provider and an independent
/// BCH reference. It must never become a dependency of the crates that hold
/// wallet truth: if OpalBase could be reached from `optn-core`, `optn-app` or
/// `optn-runtime`, there would be two authoritative implementations and no
/// rule for which one wins. Any adapter belongs behind `optn-platform`.
const APPLE_PROVIDER_NAMES: &[&str] = &[
    "opalbase",
    "swiftfulcrum",
    "opalcrypto",
    "opalfusion",
    "opalhedge",
    "opaldiagnostics",
];

fn main() {
    let command = env::args().nth(1).unwrap_or_else(|| "architecture".into());
    match command.as_str() {
        "architecture" => architecture(),
        "audit" => audit(),
        "parity" => {
            let production_ready = env::args().any(|arg| arg == "--production-ready");
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("xtask must live below workspace root")
                .to_path_buf();
            parity::run(&root, production_ready);
        }
        other => {
            eprintln!("unknown xtask '{other}'");
            std::process::exit(2);
        }
    }
}

/// Advisories accepted for now, with a reason and an expiry.
///
/// A baseline is not a dismissal: failing on an advisory that is already on
/// `dev` only makes the job permanently red and teaches everyone to ignore it.
/// But a mute that outlives its reason is worse than no mute at all, because it
/// silently accepts the vulnerability's *return*, so each entry is dropped as
/// its fix lands.
///
/// It is empty because all four entries the release workflow carries have
/// landed, which was checked rather than assumed:
///
/// - RUSTSEC-2026-0194 / 0195 (quick-xml <0.41): every lock file now resolves
///   quick-xml 0.41.0.
/// - RUSTSEC-2026-0185 (quinn-proto 0.11.14): now 0.11.17 everywhere.
/// - RUSTSEC-2026-0235 (rkyv 0.7.46): rkyv appears in no lock file at all.
///
/// `cargo audit` with no ignores exits clean across all five lock files, so
/// `.github/workflows/security-analysis.yml` can drop its four `--ignore`
/// flags. Until it does, those four are muted there for no remaining reason.
const BASELINE_ADVISORIES: &[&str] = &[];

/// Audit every Rust lock file in the repository.
///
/// The workflow's audit step runs `cargo audit` in `src-tauri` alone, so the
/// desktop shell is checked and the crates the wallet's logic actually lives in
/// -- the workspace, the CLI, the protocol core -- are not. That is the same
/// shape of hole the release verification had: a job that reports success
/// while leaving most of the tree unexamined.
///
/// Lock files are **discovered** rather than listed, so a new crate is covered
/// the day it appears instead of the day someone remembers to add it. A missing
/// `cargo-audit` is a failure, never a skip, for the same reason.
fn audit() {
    let root = repo_root();
    let mut lock_files: Vec<PathBuf> = walk_files(&root)
        .into_iter()
        .filter(|path| path.file_name().is_some_and(|name| name == "Cargo.lock"))
        .collect();
    lock_files.sort();

    if lock_files.is_empty() {
        eprintln!("dependency audit: no Cargo.lock found, which cannot be right");
        std::process::exit(1);
    }

    let mut failures = Vec::new();
    for lock in &lock_files {
        let relative = lock.strip_prefix(&root).unwrap_or(lock);
        println!("dependency audit: {}", relative.display());
        let mut command = std::process::Command::new("cargo");
        command.arg("audit").arg("--file").arg(lock);
        for advisory in BASELINE_ADVISORIES {
            command.arg("--ignore").arg(advisory);
        }
        match command.status() {
            Ok(status) if status.success() => {}
            Ok(status) => failures.push(format!("{} ({status})", relative.display())),
            Err(error) => {
                eprintln!(
                    "dependency audit: could not run cargo-audit ({error}). Install it with \
                     `cargo install cargo-audit --locked`; a missing tool is a failed audit, not \
                     a skipped one."
                );
                std::process::exit(1);
            }
        }
    }

    if failures.is_empty() {
        println!(
            "dependency audit: PASS ({} lock files, {} baselined advisories)",
            lock_files.len(),
            BASELINE_ADVISORIES.len()
        );
    } else {
        for failure in &failures {
            eprintln!("dependency audit failed: {failure}");
        }
        std::process::exit(1);
    }
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live below workspace root")
        .to_path_buf()
}

fn architecture() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live below workspace root")
        .to_path_buf();

    let neutral_manifests = [
        root.join("crates/optn-core/Cargo.toml"),
        root.join("crates/optn-app/Cargo.toml"),
        root.join("crates/optn-platform/Cargo.toml"),
        root.join("crates/optn-platform-native/Cargo.toml"),
        root.join("crates/optn-runtime/Cargo.toml"),
        root.join("crates/optn-transport/Cargo.toml"),
    ];

    let mut failures = Vec::new();
    for manifest in neutral_manifests {
        let text = manifest_body(&read(&manifest)).to_lowercase();
        for framework in FRAMEWORK_NAMES {
            if text.contains(framework) {
                failures.push(format!(
                    "{} contains forbidden framework dependency '{framework}'",
                    manifest.display()
                ));
            }
        }
    }

    // Wallet truth stays in Rust. An Apple provider is reached through
    // optn-platform's contracts, so the packages behind it must not appear in
    // the crates that own domain, application or runtime state.
    let wallet_truth_manifests = [
        root.join("crates/optn-core/Cargo.toml"),
        root.join("crates/optn-app/Cargo.toml"),
        root.join("crates/optn-runtime/Cargo.toml"),
    ];
    for manifest in wallet_truth_manifests {
        let text = manifest_body(&read(&manifest)).to_lowercase();
        for package in APPLE_PROVIDER_NAMES {
            if text.contains(package) {
                failures.push(format!(
                    "{} depends on Apple provider package '{package}'; wallet truth stays in \
                     Rust and Apple adapters belong behind optn-platform",
                    manifest.display()
                ));
            }
        }
    }

    // A second renderer keeps the first one honest. If a screen's content
    // drifts into Leptos components, optn-ui-text cannot draw it and its tests
    // fail; if a UI framework leaks into optn-app or optn-transport, it stops
    // compiling. Both only work while it depends on those two and nothing
    // else, so that is checked rather than trusted.
    let text_ui_manifest = read(&root.join("crates/optn-ui-text/Cargo.toml"));
    require_dependency(
        "crates/optn-ui-text",
        &text_ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-text",
        &text_ui_manifest,
        "optn-transport",
        &mut failures,
    );
    for framework in FRAMEWORK_NAMES {
        if manifest_body(&text_ui_manifest)
            .to_lowercase()
            .contains(framework)
        {
            failures.push(format!(
                "crates/optn-ui-text depends on '{framework}'; it exists to prove a renderer \
                 needs only optn-app and optn-transport, so a framework there defeats it"
            ));
        }
    }

    // A third renderer, on a real GUI toolkit, is the argument that the
    // renderer seam is a seam and not a Leptos-shaped hole. It only carries
    // that weight while egui is the *only* thing it adds: the moment it needs
    // optn-core, or a second UI framework, swapping toolkits stops being one
    // crate and becomes a migration again.
    let egui_ui_manifest = read(&root.join("crates/optn-ui-egui/Cargo.toml"));
    require_dependency(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        &[
            "optn-core",
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
        ],
        &mut failures,
    );
    for framework in FRAMEWORK_NAMES {
        if manifest_body(&egui_ui_manifest)
            .to_lowercase()
            .contains(framework)
        {
            failures.push(format!(
                "crates/optn-ui-egui depends on '{framework}'; it renders on egui alone, and a \
                 second framework there would mean the toolkits are not interchangeable"
            ));
        }
    }
    // eframe would drag in winit and a GPU backend, and the tests would stop
    // being runnable on a machine with no display.
    forbid_dependencies(
        "crates/optn-ui-egui",
        &egui_ui_manifest,
        &["eframe"],
        &mut failures,
    );

    let ui_manifest = read(&root.join("crates/optn-ui/Cargo.toml"));
    require_dependency("crates/optn-ui", &ui_manifest, "optn-app", &mut failures);
    require_dependency(
        "crates/optn-ui",
        &ui_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-ui",
        &ui_manifest,
        &[
            "optn-core",
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
        ],
        &mut failures,
    );

    let transport_manifest = read(&root.join("crates/optn-transport/Cargo.toml"));
    require_dependency(
        "crates/optn-transport",
        &transport_manifest,
        "optn-app",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-transport",
        &transport_manifest,
        &[
            "optn-runtime",
            "optn-platform",
            "optn-platform-native",
            "optn-ui",
        ],
        &mut failures,
    );

    let runtime_manifest = read(&root.join("crates/optn-runtime/Cargo.toml"));
    require_dependency(
        "crates/optn-runtime",
        &runtime_manifest,
        "optn-app",
        &mut failures,
    );
    require_dependency(
        "crates/optn-runtime",
        &runtime_manifest,
        "optn-transport",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-runtime",
        &runtime_manifest,
        &["optn-ui", "optn-platform-native"],
        &mut failures,
    );

    let native_manifest = read(&root.join("crates/optn-platform-native/Cargo.toml"));
    require_dependency(
        "crates/optn-platform-native",
        &native_manifest,
        "optn-platform",
        &mut failures,
    );
    forbid_dependencies(
        "crates/optn-platform-native",
        &native_manifest,
        &["optn-app", "optn-transport", "optn-runtime", "optn-ui"],
        &mut failures,
    );

    let app_manifest = read(&root.join("crates/optn-app/Cargo.toml"));
    forbid_dependencies(
        "crates/optn-app",
        &app_manifest,
        &[
            "optn-transport",
            "optn-runtime",
            "optn-platform-native",
            "optn-ui",
        ],
        &mut failures,
    );

    // The Rust renderer may use HTML/CSS build assets, but application/source
    // logic under optn-ui must remain Rust. Reference-wallet TypeScript/Vue is
    // a behavior oracle, not a migration destination.
    let ui_root = root.join("crates/optn-ui");
    for entry in walk_files(&ui_root) {
        let extension = entry
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(extension.as_str(), "js" | "jsx" | "ts" | "tsx" | "vue") {
            failures.push(format!(
                "{} is handwritten web-framework source inside the Rust renderer",
                entry.display()
            ));
        }
    }

    if failures.is_empty() {
        println!("architecture boundary check: PASS");
        return;
    }

    for failure in failures {
        eprintln!("architecture boundary violation: {failure}");
    }
    std::process::exit(1);
}

/// A manifest with its comments removed.
///
/// These guards match on manifest text, and a comment that names a crate is
/// not a dependency on it: a note explaining that a crate deliberately does
/// *not* pull something in would otherwise read as pulling it in. Stripping
/// comments also stops a comment from satisfying `require_dependency`, which
/// is the more dangerous direction of the same mistake.
fn manifest_body(manifest: &str) -> String {
    manifest
        .lines()
        .map(|line| line.split_once('#').map_or(line, |(before, _)| before))
        .collect::<Vec<_>>()
        .join("\n")
}

fn require_dependency(scope: &str, manifest: &str, dependency: &str, failures: &mut Vec<String>) {
    if !manifest_body(manifest).contains(dependency) {
        failures.push(format!(
            "{scope} must depend on '{dependency}' to preserve the intended boundary"
        ));
    }
}

fn forbid_dependencies(
    scope: &str,
    manifest: &str,
    dependencies: &[&str],
    failures: &mut Vec<String>,
) {
    let body = manifest_body(manifest);
    for dependency in dependencies {
        if body.contains(dependency) {
            failures.push(format!(
                "{scope} contains forbidden dependency '{dependency}'"
            ));
        }
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()))
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let skip = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        matches!(name, "dist" | "target" | "node_modules" | ".git")
                    });
                if !skip {
                    pending.push(path);
                }
            } else {
                files.push(path);
            }
        }
    }
    files
}
