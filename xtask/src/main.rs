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
        let text = read(&manifest).to_lowercase();
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
        let text = read(&manifest).to_lowercase();
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

fn require_dependency(scope: &str, manifest: &str, dependency: &str, failures: &mut Vec<String>) {
    if !manifest.contains(dependency) {
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
    for dependency in dependencies {
        if manifest.contains(dependency) {
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
